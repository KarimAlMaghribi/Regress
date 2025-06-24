use actix_multipart::Multipart;
use actix_web::{web, App, Error, HttpResponse, HttpServer};
use actix_web::web::Bytes;
use futures_util::StreamExt as _;
use shared::config::Settings;
use shared::dto::{UploadResponse, PdfUploaded};
use rdkafka::{producer::{FutureProducer, FutureRecord}, ClientConfig};
use tokio_postgres::NoTls;
use std::time::Duration;

async fn upload(
    mut payload: Multipart,
    db: web::Data<tokio_postgres::Client>,
    producer: web::Data<FutureProducer>,
) -> Result<HttpResponse, Error> {
    while let Some(item) = payload.next().await {
        let mut field = item?;
        let mut data = Vec::new();
        while let Some(chunk) = field.next().await {
            let bytes: Bytes = chunk?;
            data.extend_from_slice(&bytes);
        }
        let stmt = db
            .prepare("INSERT INTO pdfs (data) VALUES ($1) RETURNING id")
            .await
            .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
        let row = db
            .query_one(&stmt, &[&data])
            .await
            .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
        let id: i32 = row.get(0);
        let payload = serde_json::to_string(&PdfUploaded { id }).unwrap();
        let _ = producer
            .send(
                FutureRecord::to("pdf-uploaded").payload(&payload),
                Duration::from_secs(0),
            )
            .await;
        return Ok(HttpResponse::Ok().json(UploadResponse { id: id.to_string() }));
    }
    Ok(HttpResponse::BadRequest().finish())
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    let settings = Settings::new().unwrap();
    let (db_client, connection) =
        tokio_postgres::connect(&settings.database_url, NoTls).await.unwrap();
    let db_client = web::Data::new(db_client);
    tokio::spawn(async move { if let Err(e) = connection.await { eprintln!("db error: {e}") } });
    db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS pdfs (id SERIAL PRIMARY KEY, data BYTEA NOT NULL)",
            &[],
        )
        .await
        .unwrap();
    let producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
        .unwrap();
    let db = db_client.clone();
    HttpServer::new(move || {
        App::new()
            .app_data(db.clone())
            .app_data(web::Data::new(producer.clone()))
            .route("/upload", web::post().to(upload))
    })
    .bind(("0.0.0.0", 8081))?
    .run()
    .await
}
