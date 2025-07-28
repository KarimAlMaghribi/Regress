use actix_multipart::Multipart;
use actix_web::{web, App, Error, HttpResponse, HttpServer};
use async_stream::stream;
use chrono::{DateTime, Utc};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use sqlx::{postgres::PgPoolOptions, PgPool};
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio::sync::broadcast;
use tracing::info;
use uuid::Uuid;

#[derive(sqlx::Type, Serialize, Deserialize, Clone, Copy)]
#[sqlx(type_name = "upload_state", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum UploadState {
    Pending,
    Running,
    Success,
    Failed,
}

#[derive(sqlx::FromRow, Serialize, Deserialize)]
struct Upload {
    id: Uuid,
    filename: String,
    stored_path: String,
    ocr_status: UploadState,
    layout_status: UploadState,
    #[serde(with = "chrono::serde::ts_seconds")]
    created_at: DateTime<Utc>,
}

#[derive(Serialize, Clone)]
struct StatusEvent {
    id: Uuid,
    field: String,
    value: UploadState,
}

struct AppState {
    pool: PgPool,
    tx: broadcast::Sender<StatusEvent>,
}

async fn upload(mut payload: Multipart, data: web::Data<AppState>) -> Result<HttpResponse, Error> {
    let id = Uuid::new_v4();
    let mut filename = String::new();
    while let Some(field) = payload.next().await {
        let mut field = field?;
        if field.name() == "file" {
            let cd = field.content_disposition();
            if let Some(f) = cd.get_filename() {
                filename = f.to_string();
            }
            let path = format!("/data/uploads/{id}.pdf");
            let mut f = File::create(&path)
                .await
                .map_err(actix_web::error::ErrorInternalServerError)?;
            while let Some(chunk) = field.next().await {
                let data = chunk?;
                f.write_all(&data)
                    .await
                    .map_err(actix_web::error::ErrorInternalServerError)?;
            }
            sqlx::query("INSERT INTO uploads (id, filename, stored_path) VALUES ($1,$2,$3)")
                .bind(id)
                .bind(&filename)
                .bind(&path)
                .execute(&data.pool)
                .await
                .map_err(actix_web::error::ErrorInternalServerError)?;
            let upload: Upload = sqlx::query_as::<_, Upload>("SELECT * FROM uploads WHERE id=$1")
                .bind(id)
                .fetch_one(&data.pool)
                .await
                .map_err(actix_web::error::ErrorInternalServerError)?;
            info!(id=%id, "stored upload");
            tokio::spawn(simulate(id, data.clone()));
            return Ok(HttpResponse::Created().json(upload));
        }
    }
    Ok(HttpResponse::BadRequest().finish())
}

async fn list_uploads(data: web::Data<AppState>) -> Result<HttpResponse, Error> {
    let items: Vec<Upload> =
        sqlx::query_as::<_, Upload>("SELECT * FROM uploads ORDER BY created_at DESC")
            .fetch_all(&data.pool)
            .await
            .map_err(actix_web::error::ErrorInternalServerError)?;
    Ok(HttpResponse::Ok().json(items))
}

async fn stream(data: web::Data<AppState>) -> Result<HttpResponse, Error> {
    let mut rx = data.tx.subscribe();
    let event_stream = stream! {
        while let Ok(evt) = rx.recv().await {
            let payload = serde_json::to_string(&evt).unwrap();
            yield Ok::<_, Error>(web::Bytes::from(format!("data: {}\n\n", payload)));
        }
    };
    Ok(HttpResponse::Ok()
        .insert_header(("Content-Type", "text/event-stream"))
        .streaming(event_stream))
}

async fn simulate(id: Uuid, data: web::Data<AppState>) {
    let _ = data.tx.send(StatusEvent {
        id,
        field: "ocr_status".into(),
        value: UploadState::Running,
    });
    sqlx::query("UPDATE uploads SET ocr_status='running' WHERE id=$1")
        .bind(id)
        .execute(&data.pool)
        .await
        .ok();
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    let _ = data.tx.send(StatusEvent {
        id,
        field: "ocr_status".into(),
        value: UploadState::Success,
    });
    sqlx::query("UPDATE uploads SET ocr_status='success' WHERE id=$1")
        .bind(id)
        .execute(&data.pool)
        .await
        .ok();
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    let _ = data.tx.send(StatusEvent {
        id,
        field: "layout_status".into(),
        value: UploadState::Running,
    });
    sqlx::query("UPDATE uploads SET layout_status='running' WHERE id=$1")
        .bind(id)
        .execute(&data.pool)
        .await
        .ok();
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    let _ = data.tx.send(StatusEvent {
        id,
        field: "layout_status".into(),
        value: UploadState::Success,
    });
    sqlx::query("UPDATE uploads SET layout_status='success' WHERE id=$1")
        .bind(id)
        .execute(&data.pool)
        .await
        .ok();
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt().json().init();
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL missing");
    let pool = PgPoolOptions::new()
        .connect(&database_url)
        .await
        .expect("db");
    let (tx, _rx) = broadcast::channel(32);
    let data = web::Data::new(AppState { pool, tx });
    HttpServer::new(move || {
        App::new()
            .app_data(data.clone())
            .route("/uploads", web::post().to(upload))
            .route("/uploads", web::get().to(list_uploads))
            .route("/uploads/stream", web::get().to(stream))
    })
    .bind(("0.0.0.0", 8095))?
    .run()
    .await
}
