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
use serde::Serialize;
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

#[derive(Serialize)]
struct AnalysisResult {
    regress: Option<bool>,
    metrics: serde_json::Value,
    responses: serde_json::Value,
    error: Option<String>,
    score: f64,
    result_label: String,
}

#[derive(serde::Deserialize)]
struct PromptCfg {
    text: String,
    #[serde(default = "default_weight")]
    weight: f64,
}

fn default_weight() -> f64 {
    1.0
}

#[derive(serde::Deserialize)]
struct AiAnswer {
    answer: String,
    result: bool,
}

fn compute_score(metrics: &serde_json::Value) -> f64 {
    metrics
        .get("rules")
        .and_then(|v| v.as_array())
        .map(|rules| {
            rules.iter().fold(0.0, |acc, r| {
                let weight = r.get("weight").and_then(|v| v.as_f64()).unwrap_or(1.0);
                let res = r.get("result").and_then(|v| v.as_bool()).unwrap_or(false);
                if res {
                    acc + weight
                } else {
                    acc
                }
            })
        })
        .unwrap_or(0.0)
}

fn label_for_score(score: f64) -> String {
    if score < 0.3 {
        "KEIN_REGRESS".into()
    } else if score < 0.7 {
        "MÖGLICHER_REGRESS".into()
    } else {
        "SICHER_REGRESS".into()
    }
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
        let mut metrics: serde_json::Value = row.get(1);
        let responses: serde_json::Value = row.get(2);
        let error_msg: Option<String> = row.get(3);
        // metrics already contain rule results
        let score = compute_score(&metrics);
        let body = AnalysisResult {
            regress,
            metrics,
            responses,
            error: error_msg.clone(),
            score,
            result_label: label_for_score(score),
        };
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
            "ALTER TABLE classifications ALTER COLUMN regress DROP NOT NULL",
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
    async fn handle_event(
        client: &Client,
        db: &tokio_postgres::Client,
        prod: &FutureProducer,
        prompt_id: i32,
        evt: TextExtracted,
    ) {
        let stmt = db
            .prepare("SELECT text FROM prompts WHERE id = $1")
            .await
            .unwrap();
        let row_opt = db.query_opt(&stmt, &[&prompt_id]).await.unwrap();
        let prompt_template: String = if let Some(row) = row_opt {
            row.get(0)
        } else if prompt_id == 0 {
            DEFAULT_PROMPT.to_string()
        } else {
            error!(prompt_id, "prompt not found");
            return;
        };
        let prompts: Vec<PromptCfg> = serde_json::from_str(&evt.prompt).unwrap_or_else(|_| {
            vec![PromptCfg {
                text: evt.prompt.clone(),
                weight: 1.0,
            }]
        });
        let mut rules = Vec::new();
        let mut answers = Vec::new();
        let mut score = 0.0;
        for p in &prompts {
            let user_content = format!(
                "{}\n\n=== BEGIN OCR TEXT ===\n{}\n=== END OCR TEXT ===",
                p.text, evt.text
            );
            let message = ChatCompletionMessage {
                role: ChatCompletionMessageRole::User,
                content: Some(user_content),
                ..Default::default()
            };
            match call_openai_chat(client, "gpt-4-turbo", vec![message]).await {
                Ok(ans) => {
                    let parsed: Result<AiAnswer, _> = serde_json::from_str(&ans);
                    let (answer, res) = match parsed {
                        Ok(v) => (v.answer, v.result),
                        Err(_) => (ans.clone(), ans.to_lowercase().contains("true")),
                    };
                    if res {
                        score += p.weight;
                    }
                    rules.push(
                        serde_json::json!({"prompt": p.text, "weight": p.weight, "result": res}),
                    );
                    answers.push(answer);
                }
                Err(e) => error!(%e, id = evt.id, "openai error"),
            }
        }
        let metrics = serde_json::json!({"rules": rules});
        let responses = serde_json::json!(answers);
        let regress = score >= 0.3;
        let stmt = db
            .prepare("INSERT INTO classifications (file_name, prompts, regress, metrics, responses, error) VALUES ($1, $2, $3, $4, $5, $6)")
            .await
            .unwrap();
        let _ = db
            .execute(
                &stmt,
                &[
                    &evt.id.to_string(),
                    &evt.prompt,
                    &regress,
                    &metrics,
                    &responses,
                    &Option::<String>::None,
                ],
            )
            .await;
        let result = ClassificationResult {
            id: evt.id,
            regress,
            prompt: evt.prompt.clone(),
            answer: serde_json::to_string(&responses).unwrap(),
            score,
            result_label: label_for_score(score),
        };
        let payload = serde_json::to_string(&result).unwrap();
        let _ = prod
            .send(
                FutureRecord::to("classification-result")
                    .payload(&payload)
                    .key(&()),
                Duration::from_secs(0),
            )
            .await;
    }

    actix_web::rt::spawn(async move {
        info!("starting kafka consume loop");
        let cons = consumer;
        let prod = producer;
        let db = worker_db;
        let client = Client::builder()
            .add_default_header((header::ACCEPT_ENCODING, "br, gzip, deflate"))
            .timeout(Duration::from_secs(30))
            .finish();
        loop {
            match cons.recv().await {
                Err(e) => error!(%e, "kafka error"),
                Ok(m) => {
                    if let Some(Ok(payload)) = m.payload_view::<str>() {
                        if let Ok(evt) = serde_json::from_str::<TextExtracted>(payload) {
                            handle_event(&client, &db, &prod, prompt_id, evt).await;
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
