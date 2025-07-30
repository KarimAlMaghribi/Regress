use rdkafka::{
    consumer::{Consumer, StreamConsumer},
    producer::{FutureProducer, FutureRecord},
    ClientConfig, Message,
};
use serde_json::Value;
use shared::dto::{PipelineConfig, PipelineRunResult, TextExtracted};
use std::time::Duration;
use tracing::{error, info};
mod builder;
mod runner;
use sqlx::PgPool;
use sqlx::Row;
use tokio::task::LocalSet;
use tracing_subscriber;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    let local = LocalSet::new();
    local.run_until(async { app_main().await }).await
}

async fn app_main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
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
                            match runner::execute(&cfg, &evt.text).await {
                                Ok(outcome) => {
                                    let result = PipelineRunResult {
                                        pdf_id: evt.pdf_id,
                                        pipeline_id: evt.pipeline_id,
                                        state: serde_json::to_value(outcome.state)?,
                                        score: outcome.last_score,
                                        label: outcome.final_label,
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
