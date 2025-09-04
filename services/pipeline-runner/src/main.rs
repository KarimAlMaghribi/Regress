use rdkafka::{
    consumer::{Consumer, StreamConsumer},
    producer::{FutureProducer, FutureRecord},
    ClientConfig, Message,
};
use serde_json::Value;
use shared::dto::{PdfUploaded, PipelineConfig, PipelineRunResult};
use shared::kafka;
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::time::Duration;
use tokio::task::LocalSet;
use tracing::{error, info, warn};
use tracing_subscriber::{fmt, EnvFilter};
use uuid::Uuid;

mod runner;

/* ------------------------------ Helpers ------------------------------ */

/// Erzwingt `sslmode=disable`, wenn kein sslmode in der URL vorhanden ist.
/// Damit verbindet sqlx garantiert im Klartext zu deiner DB (Patroni/HAProxy mit ssl=off).
fn ensure_sslmode_disable(url: &str) -> String {
    if url.contains("sslmode=") {
        url.to_string()
    } else if url.contains('?') {
        format!("{url}&sslmode=disable")
    } else {
        format!("{url}?sslmode=disable")
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    let local = LocalSet::new();
    local.run_until(async { app_main().await }).await
}

async fn app_main() -> anyhow::Result<()> {
    // Logging: Level via RUST_LOG (z.B. RUST_LOG=info,pipeline_runner=debug)
    fmt().with_env_filter(EnvFilter::from_default_env()).init();

    // Broker: MESSAGE_BROKER_URL bevorzugen, sonst BROKER, sonst kafka:9092
    let broker = std::env::var("MESSAGE_BROKER_URL")
        .or_else(|_| std::env::var("BROKER"))
        .unwrap_or_else(|_| "kafka:9092".into());

    if let Err(e) = kafka::ensure_topics(&broker, &["pipeline-run", "pipeline-result"]).await {
        warn!(%e, "failed to ensure kafka topics (continuing)");
    }

    // DATABASE_URL robust auf Klartext-Verbindung bringen
    let db_url_raw = std::env::var("DATABASE_URL").expect("DATABASE_URL missing");
    let db_url = ensure_sslmode_disable(&db_url_raw);
    if db_url != db_url_raw {
        warn!("DATABASE_URL had no sslmode – using '{}'", db_url);
    }

    // Stabilen Connection-Pool aufbauen
    let pool: PgPool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&db_url)
        .await
        .map_err(|e| {
            error!(%e, "failed to connect to Postgres");
            e
        })?;

    // Optional: Extension für gen_random_uuid(), falls Tabellen Defaults nutzen
    if let Err(e) = sqlx::query("CREATE EXTENSION IF NOT EXISTS pgcrypto;")
        .execute(&pool)
        .await
    {
        // kein harter Fehler, nur Warnung – wir generieren unten die UUID ohnehin selbst
        warn!(%e, "CREATE EXTENSION pgcrypto failed (continuing)");
    }

    // Tabellen sicherstellen (id ohne DEFAULT, da wir selbst eine UUID generieren)
    if let Err(e) = sqlx::query(
        "CREATE TABLE IF NOT EXISTS pipeline_runs (
            id UUID PRIMARY KEY,
            pipeline_id UUID NOT NULL,
            pdf_id INT NOT NULL,
            started_at TIMESTAMPTZ DEFAULT now(),
            finished_at TIMESTAMPTZ,
            overall_score REAL,
            extracted JSONB
        )",
    )
        .execute(&pool)
        .await
    {
        error!(%e, "creating table pipeline_runs failed");
        return Err(e.into());
    }

    if let Err(e) = sqlx::query(
        "CREATE TABLE IF NOT EXISTS pipeline_run_steps (
            run_id UUID REFERENCES pipeline_runs(id) ON DELETE CASCADE,
            seq_no INT,
            step_id TEXT,
            prompt_id INT,
            prompt_type TEXT,
            decision_key TEXT,
            route TEXT,
            result JSONB,
            created_at TIMESTAMPTZ DEFAULT now(),
            PRIMARY KEY (run_id, seq_no)
        )",
    )
        .execute(&pool)
        .await
    {
        error!(%e, "creating table pipeline_run_steps failed");
        return Err(e.into());
    }

    // Kafka Consumer/Producer
    let consumer: StreamConsumer = ClientConfig::new()
        .set("group.id", "pipeline-runner")
        .set("bootstrap.servers", &broker)
        // "enable.auto.commit" ist standardmäßig true – passt hier
        .create()
        .map_err(|e| {
            error!(%e, "failed to create kafka consumer");
            e
        })?;

    if let Err(e) = consumer.subscribe(&["pipeline-run"]) {
        error!(%e, "failed to subscribe to topic pipeline-run");
        // Ohne Subscription macht der Service keinen Sinn.
        return Err(e.into());
    }

    let producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &broker)
        .create()
        .map_err(|e| {
            error!(%e, "failed to create kafka producer");
            e
        })?;

    info!("pipeline-runner started (broker={})", broker);

    // Hauptloop: Events verarbeiten, Fehler *nie* nach oben propagieren
    loop {
        match consumer.recv().await {
            Err(e) => {
                error!(%e, "kafka error");
                continue;
            }
            Ok(m) => {
                // payload parsen
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

                let cfg: PipelineConfig = match serde_json::from_value::<PipelineConfig>(config_json)
                {
                    Ok(c) => c,
                    Err(e) => {
                        warn!(%e, "invalid pipeline config json");
                        continue;
                    }
                };

                // OCR-Text laden (Fix: merged_pdf_id + seitenweise Aggregation)
                let text: String = match sqlx::query_scalar::<_, Option<String>>(
                    r#"
                    SELECT COALESCE(string_agg(text, E'\n' ORDER BY page_no), '')
                    FROM pdf_texts
                    WHERE merged_pdf_id = $1
                    "#,
                )
                    .bind(evt.pdf_id)
                    .fetch_one(&pool)
                    .await
                {
                    Ok(Some(s)) => s,
                    Ok(None) => String::new(),
                    Err(e) => {
                        warn!(%e, pdf_id = evt.pdf_id, "pdf_text not found");
                        continue;
                    }
                };
                info!(id = evt.pdf_id, len = text.len(), "loaded text from db");

                // Run anlegen (UUID explizit vergeben, nicht von DB-DEFAULT abhängig)
                let run_id = Uuid::new_v4();
                if let Err(e) = sqlx::query(
                    "INSERT INTO pipeline_runs (id, pipeline_id, pdf_id) VALUES ($1,$2,$3)",
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
                match runner::execute(&cfg, &text).await {
                    Ok(outcome) => {
                        let overall = runner::compute_overall_score(&outcome.scoring);

                        // kompaktes extracted-Map bauen
                        let mut extracted: std::collections::HashMap<String, serde_json::Value> =
                            std::collections::HashMap::new();
                        for p in &outcome.extraction {
                            if let (Some(k), Some(v)) = (p.json_key.clone(), p.value.clone()) {
                                extracted.insert(k, v);
                            }
                        }

                        // Steps loggen (best-effort)
                        for rs in &outcome.log {
                            if let Err(e) = sqlx::query("INSERT INTO pipeline_run_steps (run_id, seq_no, step_id, prompt_id, prompt_type, decision_key, route, result) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)")
                                .bind(run_id)
                                .bind(rs.seq_no as i32)
                                .bind(&rs.step_id)
                                .bind(rs.prompt_id as i32)
                                .bind(rs.prompt_type.to_string())
                                .bind(&rs.decision_key)
                                .bind(&rs.route)
                                .bind(&rs.result)
                                .execute(&pool)
                                .await
                            {
                                warn!(%e, %run_id, seq=rs.seq_no, "failed to insert run step");
                            }
                        }

                        // Run abschließen
                        if let Err(e) = sqlx::query(
                            "UPDATE pipeline_runs SET finished_at = now(), overall_score = $2, extracted = $3 WHERE id = $1",
                        )
                            .bind(run_id)
                            .bind(overall)
                            .bind(serde_json::to_value(&extracted).unwrap_or(serde_json::json!({})))
                            .execute(&pool)
                            .await
                        {
                            warn!(%e, %run_id, "failed to finalize pipeline_run row");
                        }

                        // Ergebnis publizieren
                        let result = PipelineRunResult {
                            pdf_id: evt.pdf_id,
                            pipeline_id: evt.pipeline_id,
                            overall_score: overall,
                            extracted,
                            extraction: outcome.extraction,
                            scoring: outcome.scoring,
                            decision: outcome.decision,
                            log: outcome.log,
                        };

                        match serde_json::to_string(&result) {
                            Ok(payload) => {
                                let _ = producer
                                    .send(
                                        FutureRecord::to("pipeline-result")
                                            .payload(&payload)
                                            .key(&()),
                                        Duration::from_secs(0),
                                    )
                                    .await;
                            }
                            Err(e) => warn!(%e, "failed to serialize PipelineRunResult"),
                        }
                    }
                    Err(e) => {
                        error!(%e, %run_id, "pipeline execution failed");
                        // (Optional) Man könnte hier auch einen Fehlerstatus speichern.
                    }
                }
            }
        }
    }
}
