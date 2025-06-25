use actix_cors::Cors;
use actix_multipart::Multipart;
use actix_web::web::Bytes;
use actix_web::{web, App, Error, HttpResponse, HttpServer, Responder};
use actix_web::http::header;
use futures_util::StreamExt as _;
use rdkafka::{
    producer::{FutureProducer, FutureRecord},
    ClientConfig,
};
use shared::config::Settings;
use shared::dto::{PdfUploaded, UploadResponse};
use std::time::Duration;
use tokio_postgres::NoTls;
use tracing::info;

async fn upload(
    mut payload: Multipart,
    db: web::Data<tokio_postgres::Client>,
    producer: web::Data<FutureProducer>,
) -> Result<HttpResponse, Error> {
    info!("handling upload request");
    while let Some(item) = payload.next().await {
        let mut field = item?;
        if field.name() != "file" {
            continue;
        }
        let mut data = Vec::new();
        while let Some(chunk) = field.next().await {
            let bytes: Bytes = chunk?;
            data.extend_from_slice(&bytes);
        }
        info!(bytes = data.len(), "storing pdf");
        let stmt = db
            .prepare("INSERT INTO pdfs (data) VALUES ($1) RETURNING id")
            .await
            .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
        let row = db
            .query_one(&stmt, &[&data])
            .await
            .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
        let id: i32 = row.get(0);
        info!(id, "pdf stored in database");
        let payload = serde_json::to_string(&PdfUploaded { id }).unwrap();
        let _ = producer
            .send(
                FutureRecord::to("pdf-uploaded").payload(&payload).key(&()),
                Duration::from_secs(0),
            )
            .await;
        info!(id, "published pdf-uploaded event");
        return Ok(HttpResponse::Ok().json(UploadResponse { id: id.to_string() }));
    }
    Ok(HttpResponse::BadRequest().finish())
}

async fn get_pdf(
    id: web::Path<i32>,
    db: web::Data<tokio_postgres::Client>,
) -> Result<HttpResponse, Error> {
    let stmt = db
        .prepare("SELECT data FROM pdfs WHERE id=$1")
        .await
        .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
    match db.query_opt(&stmt, &[&id.into_inner()]).await {
        Ok(Some(row)) => {
            let data: Vec<u8> = row.get(0);
            Ok(HttpResponse::Ok()
                .insert_header((header::CONTENT_TYPE, "application/pdf"))
                .body(data))
        }
        Ok(None) => Ok(HttpResponse::NotFound().finish()),
        Err(e) => Err(actix_web::error::ErrorInternalServerError(e)),
    }
}

async fn health() -> impl Responder {
    "OK"
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting pdf-ingest service");
    let settings = Settings::new().unwrap();
    let (db_client, connection) = tokio_postgres::connect(&settings.database_url, NoTls)
        .await
        .unwrap();
    let db_client = web::Data::new(db_client);
    info!("connected to database");
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("db error: {e}")
        }
    });
    db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS pdfs (id SERIAL PRIMARY KEY, data BYTEA NOT NULL)",
            &[],
        )
        .await
        .unwrap();
    info!("ensured pdfs table exists");
    let producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
        .unwrap();
    info!("kafka producer created");
    let db = db_client.clone();
    HttpServer::new(move || {
        App::new()
            .wrap(Cors::permissive())
            .app_data(db.clone())
            .app_data(web::Data::new(producer.clone()))
            .route("/upload", web::post().to(upload))
            .route("/pdf/{id}", web::get().to(get_pdf))
            .route("/health", web::get().to(health))
    })
    .bind(("0.0.0.0", 8081))?
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

    #[actix_web::test]
    async fn get_pdf_ok() {
        let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://postgres:postgres@localhost/postgres".into());
        if let Ok((client, connection)) = tokio_postgres::connect(&url, NoTls).await {
            tokio::spawn(async move { let _ = connection.await; });
            client.execute("CREATE TABLE IF NOT EXISTS pdfs (id SERIAL PRIMARY KEY, data BYTEA NOT NULL)", &[]).await.unwrap();
            client.execute("INSERT INTO pdfs (data) VALUES ($1)", &[&b"test".as_slice()]).await.unwrap();
            let app = test::init_service(
                App::new()
                    .app_data(web::Data::new(client))
                    .route("/pdf/{id}", web::get().to(get_pdf))
            ).await;
            let req = test::TestRequest::get().uri("/pdf/1").to_request();
            let resp = test::call_and_read_body(&app, req).await;
            assert_eq!(&resp, b"test");
        }
    }
}
