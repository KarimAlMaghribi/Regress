use actix_web::{web, App, HttpServer, Responder};
use shared::dto::{UploadRequest, UploadResponse};
use tracing::info;

async fn health() -> impl Responder {
    "OK"
}

async fn upload(item: web::Json<UploadRequest>) -> impl Responder {
    info!(?item, "received upload request");
    web::Json(UploadResponse { id: "123".into() })
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    HttpServer::new(|| {
        App::new()
            .route("/health", web::get().to(health))
            .route("/upload", web::post().to(upload))
    })
    .bind(("0.0.0.0", 8080))?
    .run()
    .await
}
