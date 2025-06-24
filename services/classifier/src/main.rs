use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use actix_cors::Cors;
use serde::{Serialize, Deserialize};
use tracing::{info, error};
use tokio_postgres::NoTls;
use shared::config::Settings;
use shared::dto::{TextExtracted, ClassificationResult};
use serde_json::json;
use rdkafka::{
    consumer::{Consumer, StreamConsumer},
    producer::{FutureProducer, FutureRecord},
    ClientConfig, Message,
};
use std::time::Duration;
use chrono::{DateTime, Utc};

async fn health() -> impl Responder {
    "OK"
}

// OpenAI-Imports
use openai::Credentials;
use openai::chat::{ChatCompletion, ChatCompletionMessage, ChatCompletionMessageRole};

#[derive(Serialize)]
struct Classification {
    regress: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Metrics {
    accuracy: f64,
    cost: f64,
    #[serde(rename = "hallucinationRate")]
    hallucination_rate: f64,
}

#[derive(Serialize)]
struct HistoryItem {
    id: i32,
    #[serde(rename = "promptId")]
    prompt_id: String,
    #[serde(rename = "promptName", skip_serializing_if = "Option::is_none")]
    prompt_name: Option<String>,
    #[serde(rename = "pdfFilenames")]
    pdf_filenames: Vec<String>,
    #[serde(rename = "runTime")]
    run_time: DateTime<Utc>,
    metrics: Metrics,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    responses: Vec<String>,
}

#[derive(Deserialize)]
pub struct HistoryParams {
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default, rename = "start")]
    start: Option<DateTime<Utc>>,
    #[serde(default, rename = "end")]
    end: Option<DateTime<Utc>>,
    #[serde(default, rename = "promptId")]
    prompt: Option<String>,
}

#[derive(Deserialize)]
pub struct ClassifyRequest {
    pdf_id: i32,
    #[serde(rename = "promptId")]
    prompt_id: i32,
}

pub async fn history(
    db: web::Data<tokio_postgres::Client>,
    params: web::Query<HistoryParams>,
) -> actix_web::Result<HttpResponse> {
    let mut query = String::from(
        "SELECT id, run_time, file_name, prompts, regress, metrics, responses FROM classifications",
    );
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<Box<dyn tokio_postgres::types::ToSql + Sync>> = Vec::new();

    if let Some(ref p) = params.prompt {
        clauses.push(format!("prompts ILIKE ${}", values.len() + 1));
        values.push(Box::new(format!("%{}%", p)));
    }
    if let Some(start) = params.start {
        clauses.push(format!("run_time >= ${}", values.len() + 1));
        values.push(Box::new(start));
    }
    if let Some(end) = params.end {
        clauses.push(format!("run_time <= ${}", values.len() + 1));
        values.push(Box::new(end));
    }
    if !clauses.is_empty() {
        query.push_str(" WHERE ");
        query.push_str(&clauses.join(" AND "));
    }
    query.push_str(" ORDER BY id DESC");
    if let Some(l) = params.limit {
        query.push_str(&format!(" LIMIT {}", l));
    }

    let rows = db
        .query(&query, &values.iter().map(|v| &**v).collect::<Vec<_>>())
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    let items: Vec<HistoryItem> = rows
        .into_iter()
        .map(|r| {
            let metrics_value: serde_json::Value = r.get(5);
            let metrics: Metrics = serde_json::from_value(metrics_value).unwrap_or_default();
            let responses_value: serde_json::Value = r.get(6);
            let responses: Vec<String> = serde_json::from_value(responses_value).unwrap_or_default();
            HistoryItem {
                id: r.get(0),
                prompt_id: r.get::<_, String>(3),
                prompt_name: None,
                pdf_filenames: vec![r.get::<_, Option<String>>(2).unwrap_or_default()],
                run_time: r.get(1),
                metrics,
                responses,
            }
        })
        .collect();

    Ok(HttpResponse::Ok().json(items))
}

pub async fn classify(
    req: web::Json<ClassifyRequest>,
    db: web::Data<tokio_postgres::Client>,
) -> actix_web::Result<HttpResponse> {
    info!(pdf_id = req.pdf_id, prompt_id = req.prompt_id, "classification request");

    let stmt = db
        .prepare("SELECT text FROM pdf_texts WHERE pdf_id = $1")
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let row = db
        .query_opt(&stmt, &[&req.pdf_id])
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let Some(row) = row else {
        return Err(actix_web::error::ErrorNotFound("pdf text"));
    };
    let extracted_text: String = row.get(0);

    let stmt = db
        .prepare("SELECT text FROM prompts WHERE id = $1")
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let row = db
        .query_opt(&stmt, &[&req.prompt_id])
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let Some(row) = row else {
        return Err(actix_web::error::ErrorNotFound("prompt"));
    };
    let prompt_template: String = row.get(0);

    let user_content = format!(
        "{}\n\n=== BEGIN OCR TEXT ===\n{}\n=== END OCR TEXT ===",
        prompt_template,
        extracted_text
    );
    let creds = Credentials::new(
        std::env::var("OPENAI_API_KEY").map_err(actix_web::error::ErrorInternalServerError)?,
        "https://api.openai.com",
    );
    let message = ChatCompletionMessage {
        role: ChatCompletionMessageRole::User,
        content: Some(user_content),
        ..Default::default()
    };
    info!("sending request to openai");
    let chat = ChatCompletion::builder("gpt-4-turbo", vec![message])
        .credentials(creds)
        .create()
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let answer = chat
        .choices
        .get(0)
        .and_then(|c| c.message.content.clone())
        .unwrap_or_default();
    info!(response = answer, "openai response");
    let is_regress = answer.to_lowercase().contains("true");
    info!(is_regress, "classification result");

    let metrics = json!({
        "accuracy": 0.0,
        "cost": (extracted_text.len() as f64) / 1000.0,
        "hallucinationRate": 0.0
    });
    let responses = json!([answer]);
    let stmt = db
        .prepare("INSERT INTO classifications (file_name, prompts, regress, metrics, responses) VALUES ($1, $2, $3, $4, $5)")
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    db.execute(
        &stmt,
        &[
            &req.pdf_id.to_string(),
            &req.prompt_id.to_string(),
            &is_regress,
            &metrics,
            &responses,
        ],
    )
    .await
    .map_err(actix_web::error::ErrorInternalServerError)?;

    Ok(HttpResponse::Ok().json(json!({"is_regress": is_regress})))
}

#[derive(Deserialize)]
pub struct PromptQuery {
    prompt_id: i32,
}

#[derive(Serialize)]
struct CompletionResponse {
    result: String,
}

pub async fn run_prompt(
    db: web::Data<tokio_postgres::Client>,
    query: web::Query<PromptQuery>,
) -> actix_web::Result<HttpResponse> {
    let stmt = db
        .prepare("SELECT text, name FROM prompts WHERE id = $1")
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let row = db
        .query_opt(&stmt, &[&query.prompt_id])
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let Some(row) = row else {
        return Err(actix_web::error::ErrorNotFound("prompt"));
    };
    let prompt_text: String = row.get(0);
    let prompt_name: String = row.get(1);

    // API-Key + Base-URL übergeben
    let creds = Credentials::new(
        std::env::var("OPENAI_API_KEY")
            .map_err(actix_web::error::ErrorInternalServerError)?,
        "https://api.openai.com",
    );

    info!(prompt_name, prompt_text, "sending prompt to OpenAI");
    let message = ChatCompletionMessage {
        role: ChatCompletionMessageRole::User,
        content: Some(prompt_text.clone()),
        name: None,
        function_call: None,
        tool_calls: None,
        tool_call_id: None,
    };

    let chat = ChatCompletion::builder("gpt-4-turbo", vec![message])
        .credentials(creds)
        .create()
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    let response_text = chat
        .choices
        .get(0)
        .and_then(|c| c.message.content.clone())
        .unwrap_or_default();
    info!(prompt_name, prompt_text, response_text, "openai completion returned");

    let stmt = db
        .prepare(
            "INSERT INTO api_logs (prompt_id, prompt_name, prompt_text, response_text, run_time) \
             VALUES ($1, $2, $3, $4, now())",
        )
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    db.execute(
        &stmt,
        &[&query.prompt_id, &prompt_name, &prompt_text, &response_text],
    )
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    Ok(HttpResponse::Ok().json(CompletionResponse { result: response_text }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, web, App};

    #[actix_rt::test]
    async fn store_and_fetch() {
        let db_url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://postgres:postgres@localhost/regress".into());
        let (client, connection) =
            tokio_postgres::connect(&db_url, NoTls).await.unwrap_or_else(|_| {
                eprintln!("Database not available, skipping test");
                std::process::exit(0)
            });
        tokio::spawn(async move { let _ = connection.await; });
        client
            .execute(
                "CREATE TABLE IF NOT EXISTS classifications (
                    id SERIAL PRIMARY KEY,
                    run_time TIMESTAMPTZ DEFAULT now(),
                    file_name TEXT,
                    prompts TEXT,
                    regress BOOLEAN NOT NULL,
                    metrics JSONB NOT NULL,
                    responses JSONB NOT NULL
                )",
                &[],
            )
            .await
            .unwrap();

        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(client.clone()))
                .route("/classify", web::post().to(classify))
                .route("/history", web::get().to(history)),
        )
            .await;

        let req = test::TestRequest::post().uri("/classify").to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());

        let resp = test::TestRequest::get().uri("/history").to_request();
        let body = test::call_and_read_body_json::<Vec<HistoryItem>>(&app, resp).await;
        assert!(!body.is_empty());
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting classifier service");

    let settings = Settings::new().unwrap_or_else(|_| Settings {
        database_url: "postgres://postgres:postgres@db:5432/regress".into(),
        message_broker_url: String::new(),
    });
    let (db_client, connection) =
        tokio_postgres::connect(&settings.database_url, NoTls).await.unwrap();
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("db error: {e}");
        }
    });
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
    db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS classifications (
                id SERIAL PRIMARY KEY,
                run_time TIMESTAMPTZ DEFAULT now(),
                file_name TEXT,
                prompts TEXT,
                regress BOOLEAN NOT NULL,
                metrics JSONB NOT NULL,
                responses JSONB NOT NULL
            )",
            &[],
        )
        .await
        .unwrap();
    let db = web::Data::new(db_client);
    let db_clone = db.clone();
    let cons = consumer;
    let prod = producer;
    let prompt_id: i32 = std::env::var("CLASS_PROMPT_ID")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    let openai_key = std::env::var("OPENAI_API_KEY").unwrap_or_default();
    tokio::spawn(async move {
        info!("starting kafka consume loop");
        loop {
            match cons.recv().await {
                Err(e) => error!(%e, "kafka error"),
                Ok(m) => {
                    if let Some(Ok(payload)) = m.payload_view::<str>() {
                        if let Ok(event) = serde_json::from_str::<TextExtracted>(payload) {
                            info!(id = event.id, "received text-extracted event");
                            let stmt = db_clone
                                .prepare("SELECT text FROM prompts WHERE id = $1")
                                .await
                                .unwrap();
                            let row = match db_clone.query_opt(&stmt, &[&prompt_id]).await {
                                Ok(r) => r,
                                Err(e) => {
                                    error!(%e, "failed to load prompt");
                                    continue;
                                }
                            };
                            let Some(row) = row else { continue };
                            let prompt_template: String = row.get(0);
                            let user_content = format!(
                                "{}\n\n=== BEGIN OCR TEXT ===\n{}\n=== END OCR TEXT ===",
                                prompt_template,
                                event.text
                            );
                            let message = ChatCompletionMessage {
                                role: ChatCompletionMessageRole::User,
                                content: Some(user_content),
                                ..Default::default()
                            };
                            let creds = Credentials::new(openai_key.clone(), "https://api.openai.com");
                            let chat = match ChatCompletion::builder("gpt-4-turbo", vec![message])
                                .credentials(creds)
                                .create()
                                .await
                            {
                                Ok(c) => c,
                                Err(e) => {
                                    error!(%e, id = event.id, "openai error");
                                    continue;
                                }
                            };
                            let answer = chat
                                .choices
                                .get(0)
                                .and_then(|c| c.message.content.clone())
                                .unwrap_or_default();
                            let is_regress = answer.to_lowercase().contains("true");
                            info!(id = event.id, is_regress, "openai classification done");
                            let metrics = serde_json::json!({
                                "accuracy": 0.0,
                                "cost": (event.text.len() as f64) / 1000.0,
                                "hallucinationRate": 0.0
                            });
                            let responses = serde_json::json!([answer]);
                            let stmt = db_clone
                                .prepare("INSERT INTO classifications (file_name, prompts, regress, metrics, responses) VALUES ($1, $2, $3, $4, $5)")
                                .await
                                .unwrap();
                            let _ = db_clone
                                .execute(
                                    &stmt,
                                    &[&event.id.to_string(), &prompt_id.to_string(), &is_regress, &metrics, &responses],
                                )
                                .await;
                            let result = ClassificationResult { id: event.id, regress: is_regress };
                            let payload = serde_json::to_string(&result).unwrap();
                            let _ = prod
                                .send(
                                    FutureRecord::to("classification-result")
                                        .payload(&payload)
                                        .key(&()),
                                    Duration::from_secs(0),
                                )
                                .await;
                            info!(id = event.id, "classification published");
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
            .route("/classify", web::post().to(classify))
            .route("/history", web::get().to(history))
            .route("/run_prompt", web::get().to(run_prompt))
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

    #[actix_rt::test]
    async fn health_ok() {
        let app = test::init_service(App::new().route("/health", web::get().to(health))).await;
        let req = test::TestRequest::get().uri("/health").to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());
    }
}
