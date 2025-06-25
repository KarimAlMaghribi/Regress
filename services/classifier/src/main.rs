use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use actix_cors::Cors;
use shared::{config::Settings, dto::{TextExtracted, ClassificationResult}};
use rdkafka::{consumer::{Consumer, StreamConsumer}, producer::{FutureProducer, FutureRecord}, ClientConfig, Message};
use openai::{Credentials, chat::{ChatCompletion, ChatCompletionMessage, ChatCompletionMessageRole}};
use tokio_postgres::NoTls;
use tracing::{info, error};
use std::time::Duration;

async fn health() -> impl Responder {
    "OK"
}

async fn get_result(path: web::Path<i32>, db: web::Data<tokio_postgres::Client>) -> actix_web::Result<HttpResponse> {
    let id = path.into_inner();
    let stmt = db
        .prepare("SELECT regress, metrics, responses FROM classifications WHERE file_name = $1")
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let row = db
        .query_opt(&stmt, &[&id.to_string()])
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    if let Some(row) = row {
        let regress: bool = row.get(0);
        let metrics: serde_json::Value = row.get(1);
        let responses: serde_json::Value = row.get(2);
        let body = serde_json::json!({
            "regress": regress,
            "metrics": metrics,
            "responses": responses,
        });
        Ok(HttpResponse::Ok().json(body))
    } else {
        Err(actix_web::error::ErrorNotFound("result"))
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting classifier service");
    let settings = Settings::new().unwrap();
    let (db_client, connection) = tokio_postgres::connect(&settings.database_url, NoTls).await.unwrap();
    let db_client = web::Data::new(db_client);
    tokio::spawn(async move { if let Err(e) = connection.await { eprintln!("db error: {e}") } });
    db_client.execute(
        "CREATE TABLE IF NOT EXISTS classifications (id SERIAL PRIMARY KEY, run_time TIMESTAMPTZ DEFAULT now(), file_name TEXT, prompts TEXT, regress BOOLEAN NOT NULL, metrics JSONB NOT NULL, responses JSONB NOT NULL)",
        &[]
    ).await.unwrap();
    db_client.execute(
        "CREATE TABLE IF NOT EXISTS prompts (id SERIAL PRIMARY KEY, text TEXT NOT NULL, name TEXT)",
        &[]
    ).await.unwrap();

    let consumer: StreamConsumer = ClientConfig::new()
        .set("group.id", "classifier")
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
        .unwrap();
    consumer.subscribe(&["text-extracted"]).unwrap();
    let producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
        .unwrap();

    let db = db_client.clone();
    let openai_key = settings.openai_api_key.clone();
    let prompt_id = settings.class_prompt_id;
    let worker_db = db.clone();
    tokio::spawn(async move {
        let cons = consumer;
        let prod = producer;
        let db = worker_db;
        loop {
            match cons.recv().await {
                Err(e) => error!(%e, "kafka error"),
                Ok(m) => {
                    if let Some(Ok(payload)) = m.payload_view::<str>() {
                        if let Ok(evt) = serde_json::from_str::<TextExtracted>(payload) {
                            info!(id = evt.id, "received text-extracted event");
                            let stmt = db.prepare("SELECT text, name FROM prompts WHERE id = $1").await.unwrap();
                            let row_opt = db.query_opt(&stmt, &[&prompt_id]).await.unwrap();
                            let Some(row) = row_opt else {
                                error!(prompt_id, "prompt not found");
                                continue;
                            };
                            let prompt_template: String = row.get(0);
                            let user_content = format!(
                                "{}\n\n=== BEGIN OCR TEXT ===\n{}\n=== END OCR TEXT ===",
                                prompt_template,
                                evt.text
                            );
                            let message = ChatCompletionMessage {
                                role: ChatCompletionMessageRole::User,
                                content: Some(user_content),
                                ..Default::default()
                            };
                            let creds = Credentials::new(openai_key.clone(), "https://api.openai.com");
                            match ChatCompletion::builder("gpt-4-turbo", vec![message]).credentials(creds).create().await {
                                Ok(chat) => {
                                    let answer = chat.choices.get(0).and_then(|c| c.message.content.clone()).unwrap_or_default();
                                    let is_regress = answer.to_lowercase().contains("true");
                                    info!(id = evt.id, is_regress, "openai classification done");
                                    let metrics = serde_json::json!({
                                        "accuracy": 0.0,
                                        "cost": (evt.text.len() as f64) / 1000.0,
                                        "hallucinationRate": 0.0
                                    });
                                    let responses = serde_json::json!([answer]);
                                    let stmt = db.prepare("INSERT INTO classifications (file_name, prompts, regress, metrics, responses) VALUES ($1, $2, $3, $4, $5)").await.unwrap();
                                    let _ = db.execute(&stmt, &[&evt.id.to_string(), &prompt_id.to_string(), &is_regress, &metrics, &responses]).await;
                                    let result = ClassificationResult { id: evt.id, regress: is_regress };
                                    let payload = serde_json::to_string(&result).unwrap();
                                    let _ = prod.send(FutureRecord::to("classification-result").payload(&payload).key(&()), Duration::from_secs(0)).await;
                                    info!(id = evt.id, "classification-result published");
                                }
                                Err(e) => error!(%e, id = evt.id, "openai error"),
                            }
                        }
                    }
                }
            }
        }
    });

    HttpServer::new(move || {
        App::new()
            .wrap(Cors::permissive())
            .app_data(db.clone())
            .route("/results/{id}", web::get().to(get_result))
            .route("/health", web::get().to(health))
    })
    .bind(("0.0.0.0", 8084))?
    .run()
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, web, App};

    #[actix_web::test]
    async fn health_ok() {
        let app = test::init_service(App::new().route("/health", web::get().to(health))).await;
        let req = test::TestRequest::get().uri("/health").to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());
    }
}
