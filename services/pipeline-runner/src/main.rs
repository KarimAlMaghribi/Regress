//! Entry point for the pipeline runner service handling pipeline execution and persistence.

use rdkafka::{
    consumer::{Consumer, StreamConsumer},
    producer::{FutureProducer, FutureRecord},
    ClientConfig, Message,
};
use serde_json::{json, Value};
use shared::dto::{
    PdfUploaded, PipelineConfig, PipelineRunResult, PromptResult, TextPosition, TernaryLabel,
};
use shared::openai_client;
use shared::openai_settings;
use sqlx::{postgres::PgPoolOptions, types::time::{format_description::well_known::Rfc3339, OffsetDateTime}, PgPool};

use std::collections::HashMap;
use std::time::Duration;
use tokio::task::LocalSet;
use tracing::{error, info, warn};
use tracing_subscriber::{fmt, EnvFilter};
use uuid::Uuid;

mod runner;

/// Ensures the connection string explicitly disables SSL for local usage.
fn ensure_sslmode_disable(url: &str) -> String {
    if url.to_ascii_lowercase().contains("sslmode=") {
        return url.to_string();
    }

    let disable_for_local = url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_ascii_lowercase()))
        .map(|host| matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1"))
        .unwrap_or(false);

    if !disable_for_local {
        return url.to_string();
    }

    if url.contains('?') {
        format!("{url}&sslmode=disable")
    } else {
        format!("{url}?sslmode=disable")
    }
}

/// Parses an environment variable or falls back to a default value.
fn env_parse<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<T>().ok())
        .unwrap_or(default)
}

#[tokio::main(flavor = "multi_thread")]
/// Tokio entry point that installs tracing and delegates to [`app_main`].
async fn main() -> anyhow::Result<()> {
    let local = LocalSet::new();
    local.run_until(async { app_main().await }).await
}

/// Sets up dependencies and runs the pipeline runner event loop.
async fn app_main() -> anyhow::Result<()> {
    fmt().with_env_filter(EnvFilter::from_default_env()).init();

    let broker = std::env::var("MESSAGE_BROKER_URL")
        .or_else(|_| std::env::var("BROKER"))
        .unwrap_or_else(|_| "kafka:9092".into());

    if let Err(e) =
        shared::kafka::ensure_topics(&broker, &["pipeline-run", "pipeline-result"]).await
    {
        warn!(%e, "failed to ensure kafka topics (continuing)");
    }

    let db_url_raw = std::env::var("DATABASE_URL").expect("DATABASE_URL missing");
    let db_url = ensure_sslmode_disable(&db_url_raw);
    if db_url != db_url_raw {
        warn!("DATABASE_URL had no sslmode – using '{}'", db_url);
    }

    let batch_cfg = runner::BatchCfg {
        page_batch_size: env_parse("PIPELINE_PAGE_BATCH_SIZE", 5usize),
        max_parallel: env_parse("PIPELINE_MAX_PARALLEL", 3usize),
        max_chars: env_parse("PIPELINE_MAX_CHARS", 20_000usize),
        openai_timeout_ms: env_parse("PIPELINE_OPENAI_TIMEOUT_MS", 25_000u64),
        openai_retries: env_parse("PIPELINE_OPENAI_RETRIES", 2usize),
    };
    info!(
        "batch_cfg={{page_batch_size:{}, max_parallel:{}, max_chars:{}, timeout_ms:{}, retries:{}}}",
        batch_cfg.page_batch_size, batch_cfg.max_parallel, batch_cfg.max_chars,
        batch_cfg.openai_timeout_ms, batch_cfg.openai_retries
    );

    // Configure a SQLx pool with conservative timeouts so long-running batches stay healthy.
    let pool: PgPool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(10))
        .idle_timeout(Some(Duration::from_secs(600)))
        .max_lifetime(Some(Duration::from_secs(1800)))
        .test_before_acquire(true)
        .connect(&db_url)
        .await
        .map_err(|e| {
            error!(%e, "failed to connect to Postgres");
            e
        })?;

    // Ensure base tables exist before the runner consumes Kafka messages.
    let _ = sqlx::query("CREATE EXTENSION IF NOT EXISTS pgcrypto;")
        .execute(&pool)
        .await;

    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS pipeline_runs (
            id UUID PRIMARY KEY,
            pipeline_id UUID NOT NULL,
            pdf_id INT NOT NULL,
            started_at TIMESTAMPTZ DEFAULT now(),
            finished_at TIMESTAMPTZ,
            status TEXT DEFAULT 'running',
            overall_score REAL,
            final_extraction JSONB,
            final_scores JSONB,
            final_decisions JSONB
        )",
    )
        .execute(&pool)
        .await;

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
    )
        .execute(&pool)
        .await;

    // neue Spalten nachziehen (idempotent)
    let _ = sqlx::query("ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS is_final  BOOLEAN NOT NULL DEFAULT FALSE").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS final_key TEXT")
        .execute(&pool)
        .await;
    let _ = sqlx::query("ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS confidence REAL")
        .execute(&pool)
        .await;
    let _ = sqlx::query("ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS answer BOOLEAN")
        .execute(&pool)
        .await;
    let _ = sqlx::query("ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS page INT")
        .execute(&pool)
        .await;

    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_prs_run_final_type ON pipeline_run_steps (run_id, is_final, prompt_type)").execute(&pool).await;
    let _ = sqlx::query("CREATE INDEX IF NOT EXISTS idx_prs_run_final_key  ON pipeline_run_steps (run_id, final_key) WHERE is_final = TRUE").execute(&pool).await;

    let _ = sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT now()
        )",
    )
    .execute(&pool)
    .await;

    if let Err(e) = configure_openai_from_settings(&pool).await {
        warn!(%e, "failed to load OpenAI configuration from settings, using defaults");
    }

    // Configure Kafka clients with generous timeouts to support long running prompts.
    let consumer: StreamConsumer = ClientConfig::new()
        .set("group.id", "pipeline-runner")
        .set("bootstrap.servers", &broker)
        .set("enable.auto.commit", "true")
        .set("session.timeout.ms", "45000")
        .set("max.poll.interval.ms", "1800000")
        .set("heartbeat.interval.ms", "5000")
        .set("socket.keepalive.enable", "true")
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

                // Runner-konforme Deserialisierung (Clone, damit wir unten noch im JSON lesen können)
                let cfg: PipelineConfig =
                    match serde_json::from_value::<PipelineConfig>(config_json.clone()) {
                        Ok(c) => c,
                        Err(e) => {
                            warn!(%e, "invalid pipeline config json");
                            continue;
                        }
                    };

                // Per-Scoring-Step Konfiguration (promptId → min_signal)
                let mut scoring_cfg: HashMap<i32, f64> = HashMap::new();
                // Per-Decision-Step Konfiguration (promptId → min_confidence)
                let mut decision_cfg: HashMap<i32, f64> = HashMap::new();
                if let Some(steps) = config_json.get("steps").and_then(|v| v.as_array()) {
                    for s in steps {
                        let t = s.get("type").and_then(|v| v.as_str()).unwrap_or_default();
                        if t == "ScoringPrompt" {
                            let pid = s.get("promptId").and_then(|v| v.as_i64())
                                .or_else(|| s.get("prompt_id").and_then(|v| v.as_i64()));
                            if let Some(pid64) = pid {
                                let cfgv = s.get("config");
                                // min_signal oder (backcompat) max(min_weight_yes, min_weight_no)
                                let min_signal = cfgv
                                    .and_then(|c| c.get("min_signal")).and_then(|v| v.as_f64())
                                    .or_else(|| {
                                        let y = cfgv.and_then(|c| c.get("min_weight_yes")).and_then(|v| v.as_f64()).unwrap_or(0.0);
                                        let n = cfgv.and_then(|c| c.get("min_weight_no")).and_then(|v| v.as_f64()).unwrap_or(0.0);
                                        Some(y.max(n))
                                    })
                                    .unwrap_or(0.0);
                                scoring_cfg.insert(pid64 as i32, min_signal);
                            }
                        } else if t == "DecisionPrompt" {
                            let pid = s.get("promptId").and_then(|v| v.as_i64())
                                .or_else(|| s.get("prompt_id").and_then(|v| v.as_i64()));
                            if let Some(pid64) = pid {
                                let cfgv = s.get("config");
                                let min_conf = cfgv
                                    .and_then(|c| {
                                        c.get("min_confidence")
                                            .or_else(|| c.get("decision_threshold"))
                                            .or_else(|| c.get("threshold"))
                                    })
                                    .and_then(|v| v.as_f64())
                                    .map(|v| v.clamp(0.0, 1.0))
                                    .unwrap_or(0.0);
                                if min_conf > 0.0 {
                                    decision_cfg.insert(pid64 as i32, min_conf);
                                }
                            }
                        }
                    }
                }

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
                info!(
                    id = evt.pdf_id,
                    pages = pages.len(),
                    total_chars,
                    "loaded pages from db"
                );

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

                        use std::collections::BTreeMap;
                        let mut final_extraction_map = serde_json::Map::new();
                        let mut final_scores_map     = serde_json::Map::new();
                        let mut final_decisions_map  = serde_json::Map::new();

                        // Zusätzlich: typisierte Maps fürs Event
                        let mut final_scores_hm: std::collections::HashMap<String, f32> = std::collections::HashMap::new();
                        let mut final_score_labels_hm: std::collections::HashMap<String, TernaryLabel> = std::collections::HashMap::new();

                        // 2) Final-Extraction je prompt_id
                        let mut by_pid: BTreeMap<i32, Vec<&PromptResult>> = BTreeMap::new();
                        for r in &outcome.extraction {
                            by_pid.entry(r.prompt_id as i32).or_default().push(r);
                        }
                        for (pid, rows) in by_pid {
                            if rows.is_empty() {
                                continue;
                            }
                            let chosen =
                                rows.iter().find(|r| r.value.is_some()).unwrap_or(&rows[0]);
                            let key = chosen
                                .json_key
                                .clone()
                                .unwrap_or_else(|| format!("field_{}", pid));

                            // Quelle sicher extrahieren
                            let (page_opt, quote_opt, bbox_opt) = match &chosen.source {
                                Some(TextPosition { page, bbox, quote }) => {
                                    (Some(*page as i32), quote.clone(), Some(*bbox))
                                }
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
                                warn!(%e, %run_id, seq, final_key=%key, "failed to insert final extraction");
                            }
                            // Für pipeline_runs sammeln
                            final_extraction_map.insert(key.clone(), result.clone());

                            seq += 1;
                        }

                        let mut overall_inputs_bool: Vec<(bool, f32)> = Vec::new();
                        let mut overall_inputs_tri:  Vec<(f32, f32)> = Vec::new(); // (score -1..+1, weight 0..1)

                        // 2b) Final-Scoring je prompt_id: NUR min_signal, UNSURE ignorieren
                        {
                            #[derive(Default)]
                            struct ScoreAgg {
                                votes_true: i64,
                                votes_false: i64,
                                support_true: Vec<serde_json::Value>,
                                support_false: Vec<serde_json::Value>,
                                explanations_true: Vec<String>,
                                explanations_false: Vec<String>,
                                tri_sum: f64,
                                tri_wsum: f64,
                            }

                            let mut sc_by_pid: BTreeMap<i32, ScoreAgg> = BTreeMap::new();

                            // From log (bevorzugt)
                            for step in &outcome.log {
                                if step.prompt_type != shared::dto::PromptType::ScoringPrompt {
                                    continue;
                                }
                                let Ok(pid) = i32::try_from(step.prompt_id) else {
                                    continue;
                                };
                                let agg = sc_by_pid.entry(pid).or_default();

                                // pro Step: min_signal
                                let min_signal = scoring_cfg.get(&pid).copied().unwrap_or(0.0);

                                let scores = step
                                    .result
                                    .get("scores")
                                    .and_then(|v| v.as_array())
                                    .cloned()
                                    .unwrap_or_default();

                                if scores.is_empty() {
                                    if let Some(cons) = step.result.get("consolidated") {
                                        // konsolidiertes Label aus dem Modell
                                        let label = cons
                                            .get("label")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("")
                                            .to_ascii_lowercase();
                                        if label == "unsure" {
                                            continue;
                                        }
                                        let res_bool = cons.get("result").and_then(|v| v.as_bool()).unwrap_or(false);
                                        let conf  = cons.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.5);
                                        let vnum = match label.as_str() { "yes" => 1.0, "no" => -1.0, _ => if res_bool { 1.0 } else { -1.0 } };
                                        let signal = (0.6_f64*1.0 + 0.4_f64*conf).clamp(0.0, 1.0);

                                        if signal < min_signal { continue; }

                                        if res_bool { agg.votes_true += 1; } else { agg.votes_false += 1; }
                                        if let Some(src) = cons.get("source") {
                                            if res_bool { agg.support_true.push(src.clone()); } else { agg.support_false.push(src.clone()); }
                                        }
                                        if let Some(expl) = cons.get("explanation").and_then(|v| v.as_str()) {
                                            let trimmed = expl.trim();
                                            if !trimmed.is_empty() {
                                                if res_bool { agg.explanations_true.push(trimmed.to_string()); }
                                                else        { agg.explanations_false.push(trimmed.to_string()); }
                                            }
                                        }
                                        agg.tri_sum  += vnum * signal;
                                        agg.tri_wsum += signal;
                                    }
                                    continue;
                                }

                                for score in scores {
                                    // Tri-State Vote
                                    let vote = score.get("vote").and_then(|v| v.as_str()).unwrap_or("").to_ascii_lowercase();
                                    if vote == "unsure" { continue; }

                                    // Boolean für Legacy-Zwecke (Mehrheit)
                                    let res = score.get("result").and_then(|v| v.as_bool()).unwrap_or(false);

                                    let vnum = match vote.as_str() {
                                        "yes" =>  1.0,
                                        "no"  => -1.0,
                                        _ => if res { 1.0 } else { -1.0 }
                                    };
                                    let strength = score.get("strength").and_then(|v| v.as_f64()).unwrap_or(1.0);
                                    let conf     = score.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.5);
                                    let signal = (0.6_f64*strength + 0.4_f64*conf).clamp(0.0, 1.0);

                                    if signal < min_signal { continue; }

                                    // Mehrheitszähler (YES/NO)
                                    if res { agg.votes_true += 1; } else { agg.votes_false += 1; }

                                    // Support/Erklärungen sammeln
                                    if let Some(src) = score.get("source") {
                                        if res { agg.support_true.push(src.clone()); } else { agg.support_false.push(src.clone()); }
                                    }
                                    if let Some(expl) = score.get("explanation").and_then(|v| v.as_str()) {
                                        let trimmed = expl.trim();
                                        if !trimmed.is_empty() {
                                            if res { agg.explanations_true.push(trimmed.to_string()); }
                                            else   { agg.explanations_false.push(trimmed.to_string()); }
                                        }
                                    }

                                    // Score-Aggregation (−1..+1)
                                    agg.tri_sum  += vnum * signal;
                                    agg.tri_wsum += signal;
                                }

                                // Konsolidieren und Final-Step + pipeline_runs-Map füllen
                                let total_votes = agg.votes_true + agg.votes_false;
                                if total_votes <= 0 && agg.tri_wsum <= 0.0 {
                                    continue;
                                }

                                // Mehrheit entscheidet Label
                                let result_bool = agg.votes_true >= agg.votes_false;
                                let mut confidence = if total_votes > 0 {
                                    (std::cmp::max(agg.votes_true, agg.votes_false) as f32) / (total_votes as f32)
                                } else { 0.0 };
                                if !confidence.is_finite() { confidence = 0.0; }
                                let confidence = confidence.clamp(0.0, 1.0);

                                let score_tri: f64 = if agg.tri_wsum > 0.0 {
                                    (agg.tri_sum / agg.tri_wsum).clamp(-1.0, 1.0)
                                } else if result_bool { 1.0 } else { -1.0 };

                                let label = if result_bool { "yes" } else { "no" };
                                let lbl_enum = if result_bool { TernaryLabel::Yes } else { TernaryLabel::No };

                                // borrow-safe explanation & support
                                let explanation: Option<String> = if result_bool {
                                    agg.explanations_true.iter().find(|s| !s.trim().is_empty()).cloned()
                                } else {
                                    agg.explanations_false.iter().find(|s| !s.trim().is_empty()).cloned()
                                };
                                let support: Vec<serde_json::Value> = if result_bool {
                                    agg.support_true.iter().take(3).cloned().collect()
                                } else {
                                    agg.support_false.iter().take(3).cloned().collect()
                                };

                                let key = format!("score_{}", pid);
                                let result_json = serde_json::json!({
                                    "result": result_bool,
                                    "confidence": confidence,
                                    "votes_true": agg.votes_true,
                                    "votes_false": agg.votes_false,
                                    "explanation": explanation,
                                    "support": support,
                                    "score": score_tri,   // −1..+1
                                    "label": label        // "yes" | "no"
                                });

                                if let Err(e) = sqlx::query(
                                    "INSERT INTO pipeline_run_steps
                                       (run_id, seq_no, step_id, prompt_id, prompt_type, is_final, final_key, result, confidence)
                                     VALUES ($1,$2,$3,$4,'ScoringPrompt',true,$5,$6,$7)"
                                )
                                    .bind(run_id)
                                    .bind(seq)
                                    .bind("final-scoring")
                                    .bind(pid)
                                    .bind(&key)
                                    .bind(&result_json)
                                    .bind(confidence)
                                    .execute(&pool)
                                    .await
                                {
                                    warn!(%e, %run_id, seq, final_key=%key, "failed to insert final scoring");
                                }
                                seq += 1;

                                // Für pipeline_runs + Overall + Event sammeln
                                final_scores_map.insert(key.clone(), json!(score_tri));
                                final_scores_hm.insert(key.clone(), score_tri as f32);
                                final_score_labels_hm.insert(key.clone(), lbl_enum);

                                overall_inputs_tri.push((score_tri as f32, confidence));
                                overall_inputs_bool.push((result_bool, confidence));
                            }

                            // Fallback von outcome.scoring (falls log keine Inhalte hatte)
                            for r in &outcome.scoring {
                                let pid = r.prompt_id as i32;

                                let min_signal = scoring_cfg.get(&pid).copied().unwrap_or(0.0);

                                // Bool → vnum, signal = 0.5
                                let vnum = if r.result { 1.0 } else { -1.0 };
                                let signal = 0.5_f64;
                                if signal < min_signal { continue; }

                                let score_tri = vnum;
                                let result_bool = r.result;
                                let label = if result_bool { "yes" } else { "no" };
                                let lbl_enum = if result_bool { TernaryLabel::Yes } else { TernaryLabel::No };
                                let key = format!("score_{}", pid);
                                let confidence = 0.5_f32;

                                let result_json = json!({
                                    "result": r.result,
                                    "confidence": confidence,
                                    "votes_true": if r.result { 1 } else { 0 },
                                    "votes_false": if r.result { 0 } else { 1 },
                                    "explanation": r.explanation,
                                    "support": r.source,
                                    "score": score_tri,
                                    "label": label
                                });

                                if let Err(e) = sqlx::query(
                                    "INSERT INTO pipeline_run_steps
                                       (run_id, seq_no, step_id, prompt_id, prompt_type, is_final, final_key, result, confidence)
                                     VALUES ($1,$2,$3,$4,'ScoringPrompt',true,$5,$6,$7)"
                                )
                                    .bind(run_id)
                                    .bind(seq)
                                    .bind("final-scoring")
                                    .bind(pid)
                                    .bind(&key)
                                    .bind(&result_json)
                                    .bind(confidence)
                                    .execute(&pool)
                                    .await
                                {
                                    warn!(%e, %run_id, seq, final_key=%key, "failed to insert final scoring (fallback)");
                                }
                                seq += 1;

                                final_scores_map.insert(key.clone(), json!(score_tri));
                                final_scores_hm.insert(key.clone(), score_tri as f32);
                                final_score_labels_hm.insert(key.clone(), lbl_enum);

                                overall_inputs_tri.push((score_tri as f32, confidence));
                                overall_inputs_bool.push((r.result, confidence));
                            }
                        }

                        // 2c) Final-Decision je prompt_id (unverändert)
                        {
                            use std::collections::BTreeMap;

                            #[derive(Default)]
                            struct DecisionAgg {
                                route_votes: BTreeMap<String, i64>,
                                yes_votes: i64,
                                no_votes: i64,
                                support_by_route: BTreeMap<String, Vec<serde_json::Value>>,
                                explanations_by_route: BTreeMap<String, Vec<String>>,
                            }

                            fn normalize_route(route: &str) -> String {
                                route.trim().to_ascii_uppercase()
                            }

                            fn route_to_bool(route: &str) -> Option<bool> {
                                match route {
                                    "YES" | "TRUE" | "JA" | "Y" | "1" => Some(true),
                                    "NO" | "FALSE" | "NEIN" | "N" | "0" => Some(false),
                                    _ => None,
                                }
                            }

                            let mut dc_by_pid: BTreeMap<i32, DecisionAgg> = BTreeMap::new();

                            for step in &outcome.log {
                                if step.prompt_type != shared::dto::PromptType::DecisionPrompt {
                                    continue;
                                }
                                let Ok(pid) = i32::try_from(step.prompt_id) else {
                                    continue;
                                };
                                let agg = dc_by_pid.entry(pid).or_default();

                                let votes = step
                                    .result
                                    .get("votes")
                                    .and_then(|v| v.as_array())
                                    .cloned()
                                    .unwrap_or_default();

                                if votes.is_empty() {
                                    if let Some(cons) = step.result.get("consolidated") {
                                        let route = cons.get("route").and_then(|v| v.as_str()).unwrap_or("UNKNOWN");
                                        let norm = normalize_route(route);
                                        *agg.route_votes.entry(norm.clone()).or_default() += 1;
                                        if let Some(src) = cons.get("source") {
                                            agg.support_by_route.entry(norm.clone()).or_default().push(src.clone());
                                        }
                                        if let Some(b) = cons.get("boolean").and_then(|v| v.as_bool()) {
                                            if b { agg.yes_votes += 1; } else { agg.no_votes += 1; }
                                        } else if let Some(ans) = route_to_bool(&norm) {
                                            if ans { agg.yes_votes += 1; } else { agg.no_votes += 1; }
                                        }
                                    }
                                    continue;
                                }

                                for vote in votes {
                                    let route = vote.get("route").and_then(|v| v.as_str()).unwrap_or("UNKNOWN");
                                    let norm = normalize_route(route);
                                    *agg.route_votes.entry(norm.clone()).or_default() += 1;

                                    if let Some(src) = vote.get("source") {
                                        agg.support_by_route.entry(norm.clone()).or_default().push(src.clone());
                                    }

                                    if let Some(val) = vote.get("value").and_then(|v| v.get("explanation")).and_then(|x| x.as_str()) {
                                        let trimmed = val.trim();
                                        if !trimmed.is_empty() {
                                            agg.explanations_by_route.entry(norm.clone()).or_default().push(trimmed.to_string());
                                        }
                                    }

                                    if let Some(b) = vote.get("boolean").and_then(|v| v.as_bool()) {
                                        if b { agg.yes_votes += 1; } else { agg.no_votes += 1; }
                                    } else if let Some(ans) = route_to_bool(&norm) {
                                        if ans { agg.yes_votes += 1; } else { agg.no_votes += 1; }
                                    }
                                }
                            }
                            for r in &outcome.decision {
                                let pid = r.prompt_id as i32;
                                let mut agg = dc_by_pid.entry(pid).or_default();
                                let current_votes: i64 = agg.route_votes.values().sum();
                                if current_votes > 0 {
                                    continue;
                                }

                                let route = r.route.clone().unwrap_or_else(|| "UNKNOWN".into());
                                let norm = normalize_route(&route);
                                *agg.route_votes.entry(norm.clone()).or_default() += 1;

                                if let Some(src) = r.source.as_ref().and_then(|s| serde_json::to_value(s).ok()) {
                                    agg.support_by_route.entry(norm.clone()).or_default().push(src);
                                }

                                if let Some(val) = r.value.as_ref().and_then(|v| v.get("explanation")).and_then(|x| x.as_str()) {
                                    let trimmed = val.trim();
                                    if !trimmed.is_empty() {
                                        agg.explanations_by_route.entry(norm.clone()).or_default().push(trimmed.to_string());
                                    }
                                }

                                if let Some(b) = r.boolean {
                                    if b { agg.yes_votes += 1; } else { agg.no_votes += 1; }
                                } else if let Some(ans) = route_to_bool(&norm) {
                                    if ans { agg.yes_votes += 1; } else { agg.no_votes += 1; }
                                }
                            }

                            for (pid, agg) in dc_by_pid {
                                let DecisionAgg {
                                    route_votes,
                                    yes_votes,
                                    no_votes,
                                    support_by_route,
                                    explanations_by_route,
                                } = agg;

                                let total_votes: i64 = route_votes.values().sum();
                                if total_votes <= 0 {
                                    continue;
                                }

                                let (best_route, best_cnt) = route_votes
                                    .iter()
                                    .max_by(|a, b| a.1.cmp(b.1))
                                    .map(|(route, cnt)| (route.clone(), *cnt))
                                    .unwrap_or_else(|| (String::from("UNKNOWN"), 0));

                                let mut confidence = (best_cnt as f32) / (total_votes as f32);
                                if !confidence.is_finite() { confidence = 0.0; }
                                let confidence = confidence.clamp(0.0, 1.0);

                                let min_conf = decision_cfg.get(&pid).copied().unwrap_or(0.0) as f32;
                                if confidence < min_conf {
                                    continue;
                                }

                                let answer = route_to_bool(&best_route);

                                let explanation =
                                    explanations_by_route.get(&best_route).and_then(|vals| {
                                        vals.iter().find(|s| !s.trim().is_empty()).cloned()
                                    });

                                let support: Vec<serde_json::Value> = support_by_route
                                    .get(&best_route)
                                    .map(|vec| vec.iter().take(3).cloned().collect())
                                    .unwrap_or_default();

                                let key = format!("decision_{}", pid);
                                let result_json = serde_json::json!({
                                    "route": best_route,
                                    "answer": answer,
                                    "confidence": confidence,
                                    "votes_yes": agg.yes_votes,
                                    "votes_no": agg.no_votes,
                                    "explanation": explanation,
                                    "support": support
                                });

                                if let Err(e) = sqlx::query(
                                    "INSERT INTO pipeline_run_steps
                                       (run_id, seq_no, step_id, prompt_id, prompt_type, is_final, final_key, result, confidence, answer, route)
                                     VALUES ($1,$2,$3,$4,'DecisionPrompt',true,$5,$6,$7,$8,$9)"
                                )
                                    .bind(run_id)
                                    .bind(seq)
                                    .bind("final-decision")
                                    .bind(pid)
                                    .bind(&key)
                                    .bind(&result_json)
                                    .bind(confidence)
                                    .bind(answer)
                                    .bind(result_json.get("route").and_then(|x| x.as_str()).unwrap_or("UNKNOWN"))
                                    .execute(&pool)
                                    .await
                                {
                                    warn!(%e, %run_id, seq, final_key=%key, "failed to insert final decision");
                                }
                                seq += 1;

                                // Für pipeline_runs sammeln
                                final_decisions_map.insert(key.clone(), json!(answer.unwrap_or(false)));
                            }
                        }

                        // 3) Overall Score (Zahl auf Run-Ebene)
                        //    Tri-State bevorzugen (Normierung (score+1)/2), Gewicht = Konsolidierungs-Confidence.
                        let overall: f32 = if !overall_inputs_tri.is_empty() {
                            let mut sum_w = 0.0f32;
                            let mut sum_v = 0.0f32;
                            for (tri, w) in &overall_inputs_tri {
                                let norm = ((*tri).clamp(-1.0, 1.0) + 1.0) / 2.0; // 0..1
                                let ww = (*w).clamp(0.0, 1.0);
                                sum_v += norm * ww;
                                sum_w += ww;
                            }
                            if sum_w > 0.0 { (sum_v / sum_w).clamp(0.0, 1.0) } else { 0.0 }
                        } else {
                            // compute_overall_score liefert Option<f32>
                            runner::compute_overall_score(&overall_inputs_bool).unwrap_or(0.0)
                        };

                        // 3b) pipeline_runs updaten (inkl. final_* Maps)
                        let final_extraction_v = if final_extraction_map.is_empty() { Value::Null } else { Value::Object(final_extraction_map.clone()) };
                        let final_scores_v     = if final_scores_map.is_empty()     { Value::Null } else { Value::Object(final_scores_map.clone()) };
                        let final_decisions_v  = if final_decisions_map.is_empty()  { Value::Null } else { Value::Object(final_decisions_map.clone()) };

                        if let Err(e) = sqlx::query(
                            "UPDATE pipeline_runs
                               SET finished_at = now(),
                                   status = 'finished',
                                   overall_score = $2,
                                   final_extraction = COALESCE($3, final_extraction),
                                   final_scores     = COALESCE($4, final_scores),
                                   final_decisions  = COALESCE($5, final_decisions)
                             WHERE id = $1",
                        )
                            .bind(run_id)
                            .bind(overall)
                            .bind(final_extraction_v)
                            .bind(final_scores_v)
                            .bind(final_decisions_v)
                            .execute(&pool)
                            .await
                        {
                            warn!(%e, %run_id, "failed to finalize pipeline_run row");
                        }

                        // 4) Event für UI/Monitoring – mit run_id
                        let (started_at, finished_at) = match sqlx::query_as::<
                            _,
                            (Option<OffsetDateTime>, Option<OffsetDateTime>),
                        >(
                            "SELECT started_at, finished_at FROM pipeline_runs WHERE id = $1",
                        )
                        .bind(run_id)
                        .fetch_optional(&pool)
                        .await
                        {
                            Ok(Some((started, finished))) => (
                                started.and_then(|dt| dt.format(&Rfc3339).ok()),
                                finished.and_then(|dt| dt.format(&Rfc3339).ok()),
                            ),
                            Ok(None) => (None, None),
                            Err(e) => {
                                warn!(%e, %run_id, "failed to fetch pipeline_run timings");
                                (None, None)
                            }
                        };

                        let result = PipelineRunResult {
                            run_id: Some(run_id),
                            pdf_id: evt.pdf_id,
                            pipeline_id: evt.pipeline_id,
                            overall_score: Some(overall),
                            extracted: std::collections::HashMap::new(),
                            extraction: outcome.extraction,
                            scoring: outcome.scoring,
                            decision: outcome.decision,
                            log: outcome.log,
                            final_scores: Some(final_scores_hm),
                            final_score_labels: Some(final_score_labels_hm),
                            status: Some("finished".to_string()),
                            started_at,
                            finished_at,
                        };

                        if let Ok(mut result_json) = serde_json::to_value(&result) {
                            result_json["run_id"] = json!(run_id.to_string());
                            if let Ok(payload) = serde_json::to_string(&result_json) {
                                let _ = producer
                                    .send(
                                        FutureRecord::to("pipeline-result")
                                            .payload(&payload)
                                            .key(&run_id.to_string()),
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

/// Reads persisted OpenAI settings from the database and updates defaults.
async fn configure_openai_from_settings(pool: &PgPool) -> anyhow::Result<()> {
    let stored = sqlx::query_scalar::<_, String>(
        "SELECT value FROM app_settings WHERE key = $1",
    )
    .bind(openai_settings::OPENAI_VERSION_KEY)
    .fetch_optional(pool)
    .await?;

    let mut selected = openai_settings::DEFAULT_OPENAI_VERSION.to_string();
    if let Some(value) = stored {
        if openai_settings::is_valid_openai_version(&value) {
            selected = value;
        } else {
            warn!(key = %value, "invalid OpenAI version found in app_settings, using default");
        }
    }

    let option = openai_settings::option_for(&selected);
    openai_client::configure_openai_defaults(option.model, option.endpoint);
    info!(
        version = %selected,
        model = option.model,
        endpoint = option.endpoint,
        "configured OpenAI defaults"
    );

    Ok(())
}
