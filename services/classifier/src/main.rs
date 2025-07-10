use actix_cors::Cors;
use actix_web::http::header;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use awc::Client;
use openai::chat::{ChatCompletionMessage, ChatCompletionMessageRole};
use rdkafka::{
    consumer::{Consumer, StreamConsumer},
    producer::{FutureProducer, FutureRecord},
    ClientConfig, Message,
};
use shared::openai_client::call_openai_chat;
use shared::{
    config::Settings,
    dto::{ClassificationResult, TextExtracted},
};
use std::time::Duration;
use tokio_postgres::NoTls;
use tracing::{error, info};

async fn health() -> impl Responder {
    "OK"
}

async fn get_result(
    path: web::Path<i32>,
    db: web::Data<tokio_postgres::Client>,
) -> actix_web::Result<HttpResponse> {
    let id = path.into_inner();
    info!(id, "fetching classification result");
    let stmt = db
        .prepare("SELECT regress, metrics, responses, error FROM classifications WHERE id = $1")
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let row = db
        .query_opt(&stmt, &[&id])
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    if let Some(row) = row {
        let regress: Option<bool> = row.get(0);
        let metrics: serde_json::Value = row.get(1);
        let responses: serde_json::Value = row.get(2);
        let error_msg: Option<String> = row.get(3);
        let body = serde_json::json!({
            "regress": regress,
            "metrics": metrics,
            "responses": responses,
            "error": error_msg,
        });
        if error_msg.is_some() {
            Ok(HttpResponse::InternalServerError().json(body))
        } else {
            Ok(HttpResponse::Ok().json(body))
        }
    } else {
        Ok(HttpResponse::Accepted().finish())
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting classifier service");
    let settings = Settings::new().unwrap();
    if settings.openai_api_key.is_empty() {
        error!("OPENAI_API_KEY environment variable is required");
        panic!("OPENAI_API_KEY environment variable is required");
    }
    let (db_client, connection) = loop {
        match tokio_postgres::connect(&settings.database_url, NoTls).await {
            Ok(conn) => break conn,
            Err(e) => {
                info!(%e, "database connection failed, retrying in 1s");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    };
    let db_client = web::Data::new(db_client);
    actix_web::rt::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("db error: {e}")
        }
    });
    db_client.execute(
        "CREATE TABLE IF NOT EXISTS classifications (id SERIAL PRIMARY KEY, run_time TIMESTAMPTZ DEFAULT now(), file_name TEXT, prompts TEXT, regress BOOLEAN, metrics JSONB NOT NULL, responses JSONB NOT NULL, error TEXT)",
        &[]
    ).await.unwrap();
    db_client
        .execute(
            "ALTER TABLE classifications ADD COLUMN IF NOT EXISTS error TEXT",
            &[],
        )
        .await
        .unwrap();
    db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS prompts (id SERIAL PRIMARY KEY, text TEXT NOT NULL)",
            &[],
        )
        .await
        .unwrap();

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

    const DEFAULT_PROMPT: &str =
        "Is the following text describing a regression? Answer true or false.";

    let db = db_client.clone();
    let prompt_id = settings.class_prompt_id;
    let worker_db = db.clone();
    actix_web::rt::spawn(async move {
        info!("starting kafka consume loop");
        let cons = consumer;
        let prod = producer;
        let db = worker_db;
        let awc_client = Client::builder()
            .add_default_header((header::ACCEPT_ENCODING, "br, gzip, deflate"))
            .timeout(Duration::from_secs(30))
            .finish();
        loop {
            match cons.recv().await {
                Err(e) => error!(%e, "kafka error"),
                Ok(m) => {
                    if let Some(Ok(payload)) = m.payload_view::<str>() {
                        if let Ok(evt) = serde_json::from_str::<TextExtracted>(payload) {
                            info!(id = evt.id, "received text-extracted event");
                            let stmt = db
                                .prepare("SELECT text FROM prompts WHERE id = $1")
                                .await
                                .unwrap();
                            let row_opt = db.query_opt(&stmt, &[&prompt_id]).await.unwrap();
                            let prompt_template: String = if let Some(row) = row_opt {
                                info!(prompt_id, "loaded classification prompt");
                                row.get(0)
                            } else if prompt_id == 0 {
                                info!("using built-in default classification prompt");
                                DEFAULT_PROMPT.to_string()
                            } else {
                                error!(prompt_id, "prompt not found");
                                continue;
                            };
                            let user_content = format!(
                                "{}\n\n=== BEGIN OCR TEXT ===\n{}\n=== END OCR TEXT ===",
                                prompt_template, evt.text
                            );
                            let message = ChatCompletionMessage {
                                role: ChatCompletionMessageRole::User,
                                content: Some(user_content),
                                ..Default::default()
                            };
                            info!(id = evt.id, "sending request to openai");
                            match call_openai_chat(&awc_client, "gpt-4-turbo", vec![message]).await
                            {
                                Ok(answer) => {
                                    let is_regress = answer.to_lowercase().contains("true");
                                    info!(id = evt.id, is_regress, "openai classification done");
                                    let metrics = serde_json::json!({
                                        "accuracy": 0.0,
                                        "cost": (evt.text.len() as f64) / 1000.0,
                                        "hallucinationRate": 0.0
                                    });
                                    let responses = serde_json::json!([answer.clone()]);
                                    let stmt = db.prepare("INSERT INTO classifications (file_name, prompts, regress, metrics, responses, error) VALUES ($1, $2, $3, $4, $5, $6)").await.unwrap();
                                    info!(id = evt.id, "storing classification result");
                                    let _ = db
                                        .execute(
                                            &stmt,
                                            &[
                                                &evt.id.to_string(),
                                                &evt.prompt,
                                                &is_regress,
                                                &metrics,
                                                &responses,
                                                &Option::<String>::None,
                                            ],
                                        )
                                        .await;
                                    info!(id = evt.id, "classification result stored");
                                    let result = ClassificationResult {
                                        id: evt.id,
                                        regress: is_regress,
                                        prompt: evt.prompt.clone(),
                                        answer: answer.clone(),
                                    };
                                    let payload = serde_json::to_string(&result).unwrap();
                                    info!(id = evt.id, "publishing classification-result event");
                                    let _ = prod
                                        .send(
                                            FutureRecord::to("classification-result")
                                                .payload(&payload)
                                                .key(&()),
                                            Duration::from_secs(0),
                                        )
                                        .await;
                                    info!(id = evt.id, "classification-result published");
                                }
                                Err(e) => {
                                    error!(%e, id = evt.id, "openai error");
                                    let metrics = serde_json::json!({});
                                    let responses = serde_json::json!([]);
                                    let err_msg = e.to_string();
                                    let stmt = db.prepare("INSERT INTO classifications (file_name, prompts, regress, metrics, responses, error) VALUES ($1, $2, $3, $4, $5, $6)").await.unwrap();
                                    let _ = db
                                        .execute(
                                            &stmt,
                                            &[
                                                &evt.id.to_string(),
                                                &evt.prompt,
                                                &Option::<bool>::None,
                                                &metrics,
                                                &responses,
                                                &err_msg,
                                            ],
                                        )
                                        .await;
                                }
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
