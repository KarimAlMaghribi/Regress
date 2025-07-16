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
use shared::{
    config::Settings,
    dto::{ClassificationResult, TextExtracted},
};
use std::time::Duration;
use postgres_native_tls::MakeTlsConnector;
use native_tls::TlsConnector;
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

#[derive(serde::Deserialize, serde::Serialize, Debug)]
struct AiAnswer {
    /// Die menschenlesbare Erklärung
    answer: String,
    /// Das Hauptergebnis
    result: bool,
    /// Die Textstelle, aus der `result` extrahiert wurde
    source: String,
}

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone)]
struct RuleResult {
    prompt: String,
    #[serde(default = "default_weight")]
    weight: f64,
    result: bool,
}

const LOW_THRESHOLD: f64 = 0.3;
const HIGH_THRESHOLD: f64 = 0.7;

fn compute_score(rules: &[RuleResult]) -> f64 {
    let total_weight: f64 = rules.iter().map(|r| r.weight).sum();
    if total_weight == 0.0 {
        return 0.0;
    }
    let true_weight: f64 = rules.iter().filter(|r| r.result).map(|r| r.weight).sum();
    true_weight / total_weight
}

fn label_for_score(score: f64) -> String {
    if score < LOW_THRESHOLD {
        "KEIN_REGRESS".into()
    } else if score < HIGH_THRESHOLD {
        "MÖGLICHER_REGRESS".into()
    } else {
        "SICHER_REGRESS".into()
    }
}

async fn handle_openai(
    messages: Vec<ChatCompletionMessage>,
    prompt: &PromptCfg,
    rules: &mut Vec<RuleResult>,
    answers: &mut Vec<serde_json::Value>,
    api_key: &str,
) -> anyhow::Result<()> {
    use openai::chat::{ChatCompletion, ChatCompletionFunctionDefinition};
    use openai::Credentials;

    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "answer": { "type": "string", "description": "Die menschenlesbare Erklärung" },
            "result": { "type": "boolean", "description": "Das Hauptergebnis" },
            "source": { "type": "string", "description": "Die Textstelle, aus der das Ergebnis extrahiert wurde" }
        },
        "required": ["answer", "result", "source"]
    });

    let func = ChatCompletionFunctionDefinition {
        name: "report_result".to_string(),
        description: None,
        parameters: Some(schema),
    };

    let creds = Credentials::new(api_key.to_string(), "");

    let chat = ChatCompletion::builder("gpt-4-turbo", messages)
        .functions(vec![func])
        .function_call(serde_json::json!({ "name": "report_result" }))
        .credentials(creds)
        .create()
        .await?;

    if let Some(choice) = chat.choices.get(0) {
        if let Some(fcall) = &choice.message.function_call {
            match serde_json::from_str::<AiAnswer>(&fcall.arguments) {
                Ok(ai) => {
                    rules.push(RuleResult {
                        prompt: prompt.text.clone(),
                        weight: prompt.weight,
                        result: ai.result,
                    });
                    answers.push(serde_json::json!({ "answer": ai.answer, "source": ai.source }));
                }
                Err(e) => log::error!("deserialize AiAnswer: {}", e),
            }
        } else if let Some(content) = &choice.message.content {
            let res = content.trim().to_lowercase().starts_with("ja");
            rules.push(RuleResult {
                prompt: prompt.text.clone(),
                weight: prompt.weight,
                result: res,
            });
            answers.push(serde_json::json!({ "answer": content, "source": "" }));
        }
    }

    Ok(())
}

async fn get_result(
    path: web::Path<i32>,
    db: web::Data<tokio_postgres::Client>,
) -> actix_web::Result<HttpResponse> {
    let pdf_id = path.into_inner();
    info!(pdf_id, "fetching classification result by pdf id");
    // fetch the most recent classification for this PDF
    let stmt = db
        .prepare(
            "SELECT regress, metrics, responses, error FROM classifications \
             WHERE file_name = $1 ORDER BY id DESC LIMIT 1",
        )
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let row = db
        .query_opt(&stmt, &[&pdf_id.to_string()])
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    if let Some(row) = row {
        let regress: Option<bool> = row.get(0);
        let metrics: serde_json::Value = row.get(1);
        let responses: serde_json::Value = row.get(2);
        let error_msg: Option<String> = row.get(3);
        // metrics already contain rule results
        let rules: Vec<RuleResult> = metrics
            .get("rules")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let score = compute_score(&rules);
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
    std::env::set_var("OPENAI_API_KEY", &settings.openai_api_key);
    std::env::set_var("OPENAI_KEY", &settings.openai_api_key);
    let tls_connector = TlsConnector::builder().build().unwrap();
    let connector = MakeTlsConnector::new(tls_connector);
    let (db_client, connection) = loop {
        match tokio_postgres::connect(&settings.database_url, connector.clone()).await {
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

    let db = db_client.clone();
    let worker_db = db.clone();
    let api_key = settings.openai_api_key.clone();
    async fn handle_event(
        client: &Client,
        db: &tokio_postgres::Client,
        prod: &FutureProducer,
        evt: TextExtracted,
        api_key: &str,
    ) {
        info!(id = evt.id, "processing text-extracted event");
        let prompts: Vec<PromptCfg> = serde_json::from_str(&evt.prompt).unwrap_or_else(|_| {
            vec![PromptCfg {
                text: evt.prompt.clone(),
                weight: 1.0,
            }]
        });
        let mut rules: Vec<RuleResult> = Vec::new();
        let mut answers: Vec<serde_json::Value> = Vec::new();
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
            info!(id = evt.id, "calling openai");
            if let Err(e) =
                handle_openai(vec![message], p, &mut rules, &mut answers, &api_key).await
            {
                error!(%e, id = evt.id, "openai error");
            }
            info!(id = evt.id, "openai call finished");
        }
        let score = compute_score(&rules);
        let metrics = serde_json::json!({"rules": rules});
        let responses = serde_json::json!(answers);
        let regress = score >= LOW_THRESHOLD;
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
        info!(id = evt.id, "stored classification result in database");
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
        info!(id = evt.id, "published classification-result event");
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
                            info!(id = evt.id, "received text-extracted event");
                            handle_event(&client, &db, &prod, evt, &api_key).await;
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
    use actix_web::{test as actix_test, web, App};

    #[actix_web::test]
    async fn health_ok() {
        let app =
            actix_test::init_service(App::new().route("/health", web::get().to(health))).await;
        let req = actix_test::TestRequest::get().uri("/health").to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert!(resp.status().is_success());
    }

    #[test]
    fn compute_score_edge_cases() {
        let all_false = vec![
            RuleResult {
                prompt: "a".into(),
                weight: 1.0,
                result: false,
            },
            RuleResult {
                prompt: "b".into(),
                weight: 2.0,
                result: false,
            },
        ];
        assert_eq!(compute_score(&all_false), 0.0);

        let all_true = vec![
            RuleResult {
                prompt: "a".into(),
                weight: 1.0,
                result: true,
            },
            RuleResult {
                prompt: "b".into(),
                weight: 2.0,
                result: true,
            },
        ];
        assert_eq!(compute_score(&all_true), 1.0);

        let mixed = vec![
            RuleResult {
                prompt: "a".into(),
                weight: 1.0,
                result: true,
            },
            RuleResult {
                prompt: "b".into(),
                weight: 2.0,
                result: false,
            },
            RuleResult {
                prompt: "c".into(),
                weight: 1.0,
                result: true,
            },
        ];
        assert!((compute_score(&mixed) - 0.5).abs() < f64::EPSILON);

        let zero_weight = vec![RuleResult {
            prompt: "a".into(),
            weight: 0.0,
            result: true,
        }];
        assert_eq!(compute_score(&zero_weight), 0.0);
    }

    #[test]
    fn label_for_score_edges() {
        assert_eq!(label_for_score(0.0), "KEIN_REGRESS");
        assert_eq!(label_for_score(LOW_THRESHOLD), "MÖGLICHER_REGRESS");
        assert_eq!(label_for_score(HIGH_THRESHOLD - 0.01), "MÖGLICHER_REGRESS");
        assert_eq!(label_for_score(HIGH_THRESHOLD), "SICHER_REGRESS");
    }
}
