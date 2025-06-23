use actix_multipart::Multipart;
use actix_web::{web, App, Error, HttpResponse, HttpServer};
use futures_util::StreamExt as _;
use shared::dto::UploadResponse;
use std::fs::File;
use std::io::Write;
use tracing::info;

async fn upload(mut payload: Multipart) -> Result<HttpResponse, Error> {
    let mut idx = 0u32;
    while let Some(item) = payload.next().await {
        let mut field = item?;
        let file_name = format!("upload_{}.pdf", idx);
        let mut f = File::create(&file_name)?;
        while let Some(chunk) = field.next().await {
            let data = chunk?;
            f.write_all(&data)?;
        }
        idx += 1;
    }
    Ok(HttpResponse::Ok().json(UploadResponse { id: "xyz".into() }))
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    HttpServer::new(|| App::new().route("/upload", web::post().to(upload)))
        .bind(("0.0.0.0", 8081))?
        .run()
        .await
}
