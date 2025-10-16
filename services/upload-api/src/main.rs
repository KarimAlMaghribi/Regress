//! Actix Web service responsible for receiving uploads, persisting metadata,
//! and broadcasting status updates while ensuring the database schema exists.

use actix_multipart::Multipart;
use actix_web::{web, App, Error, HttpResponse, HttpServer};
use chrono::{DateTime, Utc};
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use sqlx::{postgres::PgPoolOptions, PgPool};
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio::sync::broadcast;
use tracing::{error, info};
use uuid::Uuid;

#[derive(sqlx::Type, Serialize, Deserialize, Clone, Copy, Debug)]
#[sqlx(type_name = "upload_state", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum UploadState {
    Pending,
    Running,
    Success,
    Failed,
}

#[derive(sqlx::FromRow, Serialize, Deserialize, Debug)]
struct Upload {
    id: Uuid,
    filename: String,
    stored_path: String,
    ocr_status: UploadState,
    layout_status: UploadState,
    #[serde(with = "chrono::serde::ts_seconds")]
    created_at: DateTime<Utc>,
}

#[derive(Serialize, Clone, Debug)]
struct StatusEvent {
    id: Uuid,
    field: String,
    value: UploadState,
}

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    tx: broadcast::Sender<StatusEvent>,
}

/// Append `sslmode=disable` when the connection string does not provide one so
/// local environments avoid TLS requirements.
fn ensure_sslmode_disable(url: &str) -> String {
    if url.to_ascii_lowercase().contains("sslmode=") {
        return url.to_string();
    }

    if url.contains('?') {
        format!("{url}&sslmode=disable")
    } else {
        format!("{url}?sslmode=disable")
    }
}

/// Ensure the database schema and enum definitions exist before handling data.
async fn ensure_schema(pool: &PgPool) -> Result<(), sqlx::Error> {
    // Create the enum type when missing.
    sqlx::query(
        r#"
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'upload_state') THEN
                CREATE TYPE upload_state AS ENUM ('pending','running','success','failed');
            END IF;
        END$$;
        "#,
    )
        .execute(pool)
        .await?;

    // Create the table with sensible defaults in an idempotent fashion.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS uploads (
            id            uuid PRIMARY KEY,
            filename      text NOT NULL,
            stored_path   text NOT NULL,
            ocr_status    upload_state NOT NULL DEFAULT 'pending',
            layout_status upload_state NOT NULL DEFAULT 'pending',
            created_at    timestamptz  NOT NULL DEFAULT now()
        );
        "#,
    )
        .execute(pool)
        .await?;

    Ok(())
}

async fn upload(mut payload: Multipart, data: web::Data<AppState>) -> Result<HttpResponse, Error> {
    // Ensure the upload directory exists.
    if let Err(e) = tokio::fs::create_dir_all("/data/uploads").await {
        return Err(actix_web::error::ErrorInternalServerError(e));
    }

    let id = Uuid::new_v4();
    let mut filename = String::new();

    while let Some(field_res) = payload.next().await {
        let mut field = field_res?;
        if field.name() == "file" {
            if let Some(f) = field.content_disposition().get_filename() {
                filename = f.to_string();
            } else {
                filename = "upload.pdf".into();
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

            // Insert the upload metadata while leaving statuses at `pending`.
            sqlx::query("INSERT INTO uploads (id, filename, stored_path) VALUES ($1,$2,$3)")
                .bind(id)
                .bind(&filename)
                .bind(&path)
                .execute(&data.pool)
                .await
                .map_err(actix_web::error::ErrorInternalServerError)?;

            // Fetch the freshly stored upload and return it to the client.
            let upload: Upload = sqlx::query_as::<_, Upload>("SELECT * FROM uploads WHERE id=$1")
                .bind(id)
                .fetch_one(&data.pool)
                .await
                .map_err(actix_web::error::ErrorInternalServerError)?;

            info!(%id, file=%filename, "stored upload");

            // Kick off the background status simulation.
            let state = data.clone();
            tokio::spawn(async move { simulate(id, state).await });

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

async fn sse_stream(data: web::Data<AppState>) -> Result<HttpResponse, Error> {
    let mut rx = data.tx.subscribe();
    let event_stream = async_stream::stream! {
        while let Ok(evt) = rx.recv().await {
            match serde_json::to_string(&evt) {
                Ok(payload) => {
                    let frame = format!("data: {}\n\n", payload);
                    yield Ok::<_, Error>(web::Bytes::from(frame));
                }
                Err(e) => {
                    error!(%e, "failed to serialize SSE event");
                }
            }
        }
    };

    Ok(HttpResponse::Ok()
        .insert_header(("Content-Type", "text/event-stream"))
        .insert_header(("Cache-Control", "no-cache"))
        .insert_header(("Connection", "keep-alive"))
        .streaming(event_stream))
}

/// Simulate status changes so the UI receives OCR/layout progress events.
async fn simulate(id: Uuid, data: web::Data<AppState>) {
    let _ = data.tx.send(StatusEvent {
        id,
        field: "ocr_status".into(),
        value: UploadState::Running,
    });
    let _ = sqlx::query("UPDATE uploads SET ocr_status='running' WHERE id=$1")
        .bind(id)
        .execute(&data.pool)
        .await;

    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    let _ = data.tx.send(StatusEvent {
        id,
        field: "ocr_status".into(),
        value: UploadState::Success,
    });
    let _ = sqlx::query("UPDATE uploads SET ocr_status='success' WHERE id=$1")
        .bind(id)
        .execute(&data.pool)
        .await;

    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    let _ = data.tx.send(StatusEvent {
        id,
        field: "layout_status".into(),
        value: UploadState::Running,
    });
    let _ = sqlx::query("UPDATE uploads SET layout_status='running' WHERE id=$1")
        .bind(id)
        .execute(&data.pool)
        .await;

    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    let _ = data.tx.send(StatusEvent {
        id,
        field: "layout_status".into(),
        value: UploadState::Success,
    });
    let _ = sqlx::query("UPDATE uploads SET layout_status='success' WHERE id=$1")
        .bind(id)
        .execute(&data.pool)
        .await;
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Enable JSON logging when desired.
    tracing_subscriber::fmt().json().init();

    // Load the database URL and explicitly disable TLS for local runs.
    let raw_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
        // Fallback for local testing environments.
        "postgresql://regress_app:nITj%22%2B0%28f89F@haproxy:5432/regress?sslmode=disable"
            .to_string()
    });
    let database_url = ensure_sslmode_disable(&raw_url);

    // Create the connection pool.
    let pool = match PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            error!(%e, db_url=%database_url, "failed to connect to database");
            std::process::exit(1);
        }
    };

    // Ensure the schema is present before accepting uploads.
    if let Err(e) = ensure_schema(&pool).await {
        error!(%e, "failed to ensure schema");
        std::process::exit(1);
    }

    let (tx, _rx) = broadcast::channel(32);
    let data = web::Data::new(AppState { pool, tx });

    info!("starting uploads service on :8095");
    HttpServer::new(move || {
        App::new()
            .app_data(data.clone())
            .route("/uploads", web::post().to(upload))
            .route("/uploads", web::get().to(list_uploads))
            .route("/uploads/stream", web::get().to(sse_stream))
    })
        .bind(("0.0.0.0", 8095))?
        .run()
        .await
}
