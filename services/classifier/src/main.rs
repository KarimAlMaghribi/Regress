use actix_multipart::Multipart;
use actix_web::{web, App, HttpResponse, HttpServer};
use futures_util::StreamExt as _;
use serde::{Serialize, Deserialize};
use tracing::{debug, info};
use tokio_postgres::NoTls;
use shared::config::Settings;
use chrono::{DateTime, Utc};

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
    mut payload: Multipart,
    db: web::Data<tokio_postgres::Client>,
) -> actix_web::Result<HttpResponse> {
    debug!("classification request received");
    let mut pdf_data = Vec::new();
    let mut file_name: Option<String> = None;
    let mut prompts: Vec<String> = Vec::new();

    while let Some(item) = payload.next().await {
        let mut field = item?;
        let name = field.name().to_string();
        let mut data = Vec::new();
        while let Some(chunk) = field.next().await {
            data.extend_from_slice(&chunk?);
        }
        if name == "file" {
            info!("received pdf data: {} bytes", data.len());
            file_name = field.content_disposition().get_filename().map(|s| s.to_string());
            pdf_data = data;
        } else if name == "prompts" {
            let s = String::from_utf8_lossy(&data);
            prompts = s.split(',').map(|p| p.trim().to_lowercase()).collect();
        }
    }

    let text = String::from_utf8_lossy(&pdf_data).to_lowercase();
    info!("prompts used: {:?}", prompts);
    let is_regress = if prompts.is_empty() {
        text.contains("regress")
    } else {
        prompts.iter().any(|p| text.contains(p))
    };
    info!("classification result: {}", is_regress);

    let prompts_str = prompts.join(",");
    let fname = file_name.unwrap_or_else(|| "upload".into());
    let metrics = serde_json::json!({
        "accuracy": if is_regress { 1.0 } else { 0.0 },
        "cost": (pdf_data.len() as f64) / 1000.0,
        "hallucinationRate": 0.0
    });
    let responses = serde_json::json!([format!("result={}", is_regress)]);
    let stmt = db
        .prepare("INSERT INTO classifications (file_name, prompts, regress, metrics, responses) VALUES ($1, $2, $3, $4, $5)")
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    db.execute(&stmt, &[&fname, &prompts_str, &is_regress, &metrics, &responses])
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    Ok(HttpResponse::Ok().json(Classification { regress: is_regress }))
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

    HttpServer::new(move || {
        App::new()
            .app_data(db.clone())
            .route("/classify", web::post().to(classify))
            .route("/history", web::get().to(history))
            .route("/run_prompt", web::get().to(run_prompt))
    })
        .bind(("0.0.0.0", 8084))?
        .run()
        .await
}
