use rdkafka::{
    consumer::{Consumer, StreamConsumer},
    producer::{FutureProducer, FutureRecord},
    ClientConfig, Message,
};
use serde_json::Value;
use shared::dto::{PipelineConfig, PipelineRunResult, TextExtracted};
use uuid::Uuid;
use std::time::Duration;
use tracing::{error, info};
mod builder;
mod runner;
use sqlx::PgPool;
use sqlx::Row;
use tokio::task::LocalSet;
use tracing_subscriber::{fmt, EnvFilter};

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    let local = LocalSet::new();
    local.run_until(async { app_main().await }).await
}

async fn app_main() -> anyhow::Result<()> {
    // Logging: Level via RUST_LOG steuern
    fmt().with_env_filter(EnvFilter::from_default_env()).init();
    // Prefer MESSAGE_BROKER_URL which is set for all services including
    // pipeline-runner. Fall back to BROKER or the default "kafka:9092".
    let broker = std::env::var("MESSAGE_BROKER_URL")
        .or_else(|_| std::env::var("BROKER"))
        .unwrap_or_else(|_| "kafka:9092".into());
    let db_url = std::env::var("DATABASE_URL").expect("DATABASE_URL missing");
    let pool = PgPool::connect(&db_url).await?;

    let consumer: StreamConsumer = ClientConfig::new()
        .set("group.id", "pipeline-runner")
        .set("bootstrap.servers", &broker)
        .create()?;
    consumer.subscribe(&["text-extracted"])?;
    let producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &broker)
        .create()?;
    info!("pipeline-runner started (broker={})", broker);
    loop {
        match consumer.recv().await {
            Err(e) => error!(%e, "kafka error"),
            Ok(m) => {
                if let Some(Ok(payload)) = m.payload_view::<str>() {
                    if let Ok(evt) = serde_json::from_str::<TextExtracted>(payload) {
                        info!(id = evt.pdf_id, pipeline = %evt.pipeline_id, "process event");
                        let row = sqlx::query("SELECT config_json FROM pipelines WHERE id = $1")
                            .bind(evt.pipeline_id)
                            .fetch_one(&pool)
                            .await?;
                        let config_json: Value = row.try_get("config_json")?;
                        if let Ok(cfg) = serde_json::from_value::<PipelineConfig>(config_json) {
                            let run_id: Uuid = sqlx::query_scalar!(
                                "INSERT INTO pipeline_runs (pipeline_id, pdf_id) VALUES ($1,$2) RETURNING id",
                                evt.pipeline_id,
                                evt.pdf_id
                            )
                            .fetch_one(&pool)
                            .await?;

                            match runner::execute(&cfg, &evt.text).await {
                                Ok(outcome) => {
                                    let overall = runner::compute_overall_score(&outcome.scoring);
                                    let mut extracted = std::collections::HashMap::new();
                                    for p in &outcome.extraction {
                                        if let (Some(k), Some(v)) =
                                            (p.json_key.clone(), p.value.clone())
                                        {
                                            extracted.insert(k, v);
                                        }
                                    }
                                    for rs in &outcome.log {
                                        sqlx::query!(
                                            "INSERT INTO pipeline_run_steps (run_id, seq_no, step_id, prompt_id, prompt_type, decision_key, route, merge_to, result) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                                            run_id,
                                            rs.seq_no as i32,
                                            rs.step_id,
                                            rs.prompt_id,
                                            rs.prompt_type.to_string(),
                                            rs.decision_key,
                                            rs.route,
                                            rs.merge_to,
                                            rs.result
                                        )
                                        .execute(&pool)
                                        .await?;
                                    }
                                    sqlx::query!(
                                        "UPDATE pipeline_runs SET finished_at = now(), overall_score = $2, extracted = $3 WHERE id = $1",
                                        run_id,
                                        overall,
                                        serde_json::to_value(&extracted)?
                                    )
                                    .execute(&pool)
                                    .await?;
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
                                    let payload = serde_json::to_string(&result).unwrap();
                                    let _ = producer
                                        .send(
                                            FutureRecord::to("pipeline-result")
                                                .payload(&payload)
                                                .key(&()),
                                            Duration::from_secs(0),
                                        )
                                        .await;
                                }
                                Err(e) => error!(%e, "run failed"),
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}
