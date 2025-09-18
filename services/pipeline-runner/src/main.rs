use rdkafka::{
    consumer::{Consumer, StreamConsumer},
    producer::{FutureProducer, FutureRecord},
    ClientConfig, Message,
};
use serde_json::{json, Value};
use shared::dto::{PdfUploaded, PipelineConfig, PipelineRunResult, PromptResult, TextPosition};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::time::Duration;
use tokio::task::LocalSet;
use tracing::{error, info, warn};
use tracing_subscriber::{fmt, EnvFilter};
use uuid::Uuid;

mod runner;

fn ensure_sslmode_disable(url: &str) -> String {
    if url.contains("sslmode=") {
        url.to_string()
    } else if url.contains('?') {
        format!("{url}&sslmode=disable")
    } else {
        format!("{url}?sslmode=disable")
    }
}

fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<T>().ok())
        .unwrap_or(default)
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    let local = LocalSet::new();
    local.run_until(async { app_main().await }).await
}

async fn app_main() -> anyhow::Result<()> {
    fmt().with_env_filter(EnvFilter::from_default_env()).init();

    let broker = std::env::var("MESSAGE_BROKER_URL")
        .or_else(|_| std::env::var("BROKER"))
        .unwrap_or_else(|_| "kafka:9092".into());

    if let Err(e) = shared::kafka::ensure_topics(&broker, &["pipeline-run", "pipeline-result"]).await {
        warn!(%e, "failed to ensure kafka topics (continuing)");
    }

    let db_url_raw = std::env::var("DATABASE_URL").expect("DATABASE_URL missing");
    let db_url = ensure_sslmode_disable(&db_url_raw);
    if db_url != db_url_raw {
        warn!("DATABASE_URL had no sslmode – using '{}'", db_url);
    }

    let batch_cfg = runner::BatchCfg {
        page_batch_size:      env_parse("PIPELINE_PAGE_BATCH_SIZE", 5usize),
        max_parallel:         env_parse("PIPELINE_MAX_PARALLEL", 3usize),
        max_chars:            env_parse("PIPELINE_MAX_CHARS", 20_000usize),
        openai_timeout_ms:    env_parse("PIPELINE_OPENAI_TIMEOUT_MS", 25_000u64),
        openai_retries:       env_parse("PIPELINE_OPENAI_RETRIES", 2usize),
    };
    info!(
        "batch_cfg={{page_batch_size:{}, max_parallel:{}, max_chars:{}, timeout_ms:{}, retries:{}}}",
        batch_cfg.page_batch_size, batch_cfg.max_parallel, batch_cfg.max_chars,
        batch_cfg.openai_timeout_ms, batch_cfg.openai_retries
    );

    let pool: PgPool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&db_url)
        .await
        .map_err(|e| {
            error!(%e, "failed to connect to Postgres");
            e
        })?;

    // Basis-Tabellen idempotent sicherstellen
    let _ = sqlx::query("CREATE EXTENSION IF NOT EXISTS pgcrypto;").execute(&pool).await;

    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS pipeline_runs (
            id UUID PRIMARY KEY,
            pipeline_id UUID NOT NULL,
            pdf_id INT NOT NULL,
            started_at TIMESTAMPTZ DEFAULT now(),
            finished_at TIMESTAMPTZ,
            status TEXT DEFAULT 'running',
            overall_score REAL
        )",
    ).execute(&pool).await;

    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS pipeline_run_steps (
            run_id UUID REFERENCES pipeline_runs(id) ON DELETE CASCADE,
            seq_no INT,
            step_id TEXT,
            prompt_id INT,
            prompt_type TEXT,
            decision_key TEXT,
            route TEXT,
            result JSONB,
            is_final BOOLEAN DEFAULT FALSE,
            final_key TEXT,
            confidence REAL,
            answer BOOLEAN,
            page INT,
            created_at TIMESTAMPTZ DEFAULT now(),
            PRIMARY KEY (run_id, seq_no)
        )",
    ).execute(&pool).await;

    // neue Spalten nachziehen (idempotent)
    let _ = sqlx::query("ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS is_final  BOOLEAN NOT NULL DEFAULT FALSE").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS final_key TEXT").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS confidence REAL").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS answer BOOLEAN").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS page INT").execute(&pool).await;

    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_prs_run_final_type ON pipeline_run_steps (run_id, is_final, prompt_type)").execute(&pool).await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_prs_run_final_key  ON pipeline_run_steps (run_id, final_key) WHERE is_final = TRUE").execute(&pool).await;

    // Kafka-Client
    let consumer: StreamConsumer = ClientConfig::new()
        .set("group.id", "pipeline-runner")
        .set("bootstrap.servers", &broker)
        .create()
        .map_err(|e| {
            error!(%e, "failed to create kafka consumer");
            e
        })?;
    consumer.subscribe(&["pipeline-run"]).map_err(|e| {
        error!(%e, "failed to subscribe to topic pipeline-run");
        e
    })?;

    let producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &broker)
        .create()
        .map_err(|e| {
            error!(%e, "failed to create kafka producer");
            e
        })?;

    info!("pipeline-runner started (broker={})", broker);

    loop {
        match consumer.recv().await {
            Err(e) => {
                error!(%e, "kafka error");
                continue;
            }
            Ok(m) => {
                let Some(Ok(payload)) = m.payload_view::<str>() else {
                    warn!("received message without valid UTF-8 payload");
                    continue;
                };

                let evt: PdfUploaded = match serde_json::from_str(payload) {
                    Ok(v) => v,
                    Err(e) => {
                        warn!(%e, "failed to parse PdfUploaded payload");
                        continue;
                    }
                };

                info!(id = evt.pdf_id, pipeline = %evt.pipeline_id, "processing event");

                // Pipeline-Config laden
                let row = match sqlx::query("SELECT config_json FROM pipelines WHERE id = $1")
                    .bind(evt.pipeline_id)
                    .fetch_one(&pool)
                    .await
                {
                    Ok(r) => r,
                    Err(e) => {
                        warn!(%e, pipeline = %evt.pipeline_id, "pipeline config not found");
                        continue;
                    }
                };

                let config_json: Value = match row.try_get("config_json") {
                    Ok(v) => v,
                    Err(e) => {
                        warn!(%e, "config_json column missing/invalid");
                        continue;
                    }
                };

                let cfg: PipelineConfig = match serde_json::from_value::<PipelineConfig>(config_json) {
                    Ok(c) => c,
                    Err(e) => {
                        warn!(%e, "invalid pipeline config json");
                        continue;
                    }
                };

                // Textseiten laden
                let pages: Vec<(i32, String)> = match sqlx::query(
                    r#"
                    SELECT page_no, text
                    FROM pdf_texts
                    WHERE merged_pdf_id = $1
                    ORDER BY page_no
                    "#,
                )
                    .bind(evt.pdf_id)
                    .fetch_all(&pool)
                    .await
                {
                    Ok(rows) => rows
                        .into_iter()
                        .map(|r| {
                            let pno: i32 = r.get("page_no");
                            let txt: String = r.get("text");
                            (pno, txt)
                        })
                        .collect(),
                    Err(e) => {
                        warn!(%e, pdf_id = evt.pdf_id, "pdf_texts not found");
                        continue;
                    }
                };

                let total_chars: usize = pages.iter().map(|(_, t)| t.len()).sum();
                info!(id = evt.pdf_id, pages = pages.len(), total_chars, "loaded pages from db");

                // Run anlegen
                let run_id = Uuid::new_v4();
                if let Err(e) = sqlx::query(
                    "INSERT INTO pipeline_runs (id, pipeline_id, pdf_id, status) VALUES ($1,$2,$3,'running')",
                )
                    .bind(run_id)
                    .bind(evt.pipeline_id)
                    .bind(evt.pdf_id)
                    .execute(&pool)
                    .await
                {
                    error!(%e, %run_id, "failed to insert pipeline_runs row");
                    continue;
                }

                // Ausführen
                match runner::execute_with_pages(&cfg, &pages, &batch_cfg).await {
                    Ok(outcome) => {
                        // 1) Batches als Steps loggen
                        let mut seq: i32 = 1;
                        for rs in &outcome.log {
                            if let Err(e) = sqlx::query(
                                "INSERT INTO pipeline_run_steps
                                   (run_id, seq_no, step_id, prompt_id, prompt_type, decision_key, route, result, is_final)
                                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)"
                            )
                                .bind(run_id)
                                .bind(seq)
                                .bind(&rs.step_id)
                                .bind(rs.prompt_id as i32)
                                .bind(rs.prompt_type.to_string())
                                .bind(&rs.decision_key)
                                .bind(&rs.route)
                                .bind(&rs.result)
                                .execute(&pool)
                                .await
                            {
                                warn!(%e, %run_id, seq, "failed to insert run step");
                            }
                            seq += 1;
                        }

                        // 2) Minimal: Final-Extraction je prompt_id
                        use std::collections::BTreeMap;
                        let mut by_pid: BTreeMap<i32, Vec<&PromptResult>> = BTreeMap::new();
                        for r in &outcome.extraction {
                            by_pid.entry(r.prompt_id as i32).or_default().push(r);
                        }
                        for (pid, rows) in by_pid {
                            if rows.is_empty() { continue; }
                            let chosen = rows.iter().find(|r| r.value.is_some()).unwrap_or(&rows[0]);
                            let key = chosen.json_key.clone().unwrap_or_else(|| format!("field_{}", pid));

                            // Quelle sicher extrahieren
                            let (page_opt, quote_opt, bbox_opt) = match &chosen.source {
                                Some(TextPosition { page, bbox, quote }) => (Some(*page as i32), quote.clone(), Some(*bbox)),
                                None => (None, None, None),
                            };
                            let conf = chosen.weight.unwrap_or(0.0);

                            let result = json!({
                                "value": chosen.value,
                                "confidence": conf,
                                "page": page_opt,
                                "quote": quote_opt,
                                "bbox": bbox_opt
                            });

                            if let Err(e) = sqlx::query(
                                "INSERT INTO pipeline_run_steps
                                   (run_id, seq_no, step_id, prompt_id, prompt_type, is_final, final_key, result, confidence, page)
                                 VALUES ($1,$2,$3,$4,'ExtractionPrompt',true,$5,$6,$7,$8)"
                            )
                                .bind(run_id)
                                .bind(seq)
                                .bind("final-extraction")
                                .bind(pid)
                                .bind(&key)
                                .bind(&result)
                                .bind(conf as f32)
                                .bind(page_opt)
                                .execute(&pool)
                                .await
                            {
                                warn!(%e, %run_id, seq, final_key=%key, "failed to insert minimal final extraction");
                            }
                            seq += 1;
                        }

                        // 3) Overall Score (nur Zahl auf Run-Ebene)
                        let overall = runner::compute_overall_score(&outcome.scoring);
                        if let Err(e) = sqlx::query(
                            "UPDATE pipeline_runs
                               SET finished_at = now(), status='finished', overall_score = $2
                             WHERE id = $1"
                        )
                            .bind(run_id)
                            .bind(overall)
                            .execute(&pool)
                            .await
                        {
                            warn!(%e, %run_id, "failed to finalize pipeline_run row");
                        }

                        // 4) Event fürs UI/Monitoring – mit run_id
                        let result = PipelineRunResult {
                            run_id: Some(run_id),
                            pdf_id: evt.pdf_id,
                            pipeline_id: evt.pipeline_id,
                            overall_score: overall,
                            extracted: std::collections::HashMap::new(), // Finals baut die API aus Steps
                            extraction: outcome.extraction,
                            scoring: outcome.scoring,
                            decision: outcome.decision,
                            log: outcome.log,
                        };

                        if let Ok(mut result_json) = serde_json::to_value(&result) {
                            result_json["run_id"] = json!(run_id.to_string());
                            if let Ok(payload) = serde_json::to_string(&result_json) {
                                let _ = producer
                                    .send(
                                        FutureRecord::to("pipeline-result").payload(&payload).key(&run_id.to_string()),
                                        Duration::from_secs(0),
                                    )
                                    .await;
                            }
                        }
                    }
                    Err(e) => {
                        error!(%e, %run_id, "pipeline execution failed");
                        let _ = sqlx::query("UPDATE pipeline_runs SET status='failed', finished_at=now() WHERE id=$1")
                            .bind(run_id).execute(&pool).await;
                    }
                }
            }
        }
    }
}
