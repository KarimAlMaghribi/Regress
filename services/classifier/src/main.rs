use actix_multipart::Multipart;
use actix_web::{web, App, HttpResponse, HttpServer};
use futures_util::StreamExt as _;
use serde::Serialize;
use tracing::{debug, info};
use tokio_postgres::NoTls;
use shared::config::Settings;
use chrono::{DateTime, Utc};

#[derive(Serialize)]
struct Classification {
    regress: bool,
}

#[derive(Serialize)]
struct ClassificationRecord {
    id: i32,
    run_time: DateTime<Utc>,
    file_name: Option<String>,
    prompts: String,
    regress: bool,
}

pub async fn history(db: web::Data<tokio_postgres::Client>) -> actix_web::Result<HttpResponse> {
    let rows = db
        .query(
            "SELECT id, run_time, file_name, prompts, regress FROM classifications ORDER BY id DESC",
            &[],
        )
        .await
        .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;

    let items: Vec<ClassificationRecord> = rows
        .into_iter()
        .map(|r| ClassificationRecord {
            id: r.get(0),
            run_time: r.get(1),
            file_name: r.get(2),
            prompts: r.get(3),
            regress: r.get(4),
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
            debug!("received pdf data: {} bytes", data.len());
            file_name = field.content_disposition().get_filename().map(|s| s.to_string());
            pdf_data = data;
        } else if name == "prompts" {
            let s = String::from_utf8_lossy(&data);
            prompts = s.split(',').map(|p| p.trim().to_lowercase()).collect();
        }
    }

    let text = String::from_utf8_lossy(&pdf_data).to_lowercase();
    debug!("prompts used: {:?}", prompts);
    let is_regress = if prompts.is_empty() {
        text.contains("regress")
    } else {
        prompts.iter().any(|p| text.contains(p))
    };
    info!("classification result: {}", is_regress);

    let prompts_str = prompts.join(",");
    let fname = file_name.unwrap_or_else(|| "upload".into());
    let stmt = db
        .prepare("INSERT INTO classifications (file_name, prompts, regress) VALUES ($1, $2, $3)")
        .await
        .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
    db
        .execute(&stmt, &[&fname, &prompts_str, &is_regress])
        .await
        .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;

    Ok(HttpResponse::Ok().json(Classification { regress: is_regress }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, web, App};

    #[actix_rt::test]
    async fn store_and_fetch() {
        let db_url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://postgres:postgres@localhost/regress".into());
        let (client, connection) = match tokio_postgres::connect(&db_url, NoTls).await {
            Ok(c) => c,
            Err(_) => {
                eprintln!("Database not available, skipping test");
                return;
            }
        };
        tokio::spawn(async move { let _ = connection.await; });
        client
            .execute(
                "CREATE TABLE IF NOT EXISTS classifications (id SERIAL PRIMARY KEY, run_time TIMESTAMPTZ DEFAULT now(), file_name TEXT, prompts TEXT, regress BOOLEAN NOT NULL)",
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
        let body = test::call_and_read_body_json::<Vec<ClassificationRecord>>(&app, resp).await;
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
    let (db_client, connection) = tokio_postgres::connect(&settings.database_url, NoTls).await.unwrap();
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
                regress BOOLEAN NOT NULL
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
    })
    .bind(("0.0.0.0", 8084))?
    .run()
    .await
}
