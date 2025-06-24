use actix_multipart::Multipart;
use actix_web::{web, App, HttpResponse, HttpServer};
use futures_util::StreamExt as _;
use serde::Serialize;
use tracing::{debug, info};

#[derive(Serialize)]
struct Classification {
    regress: bool,
}

async fn classify(mut payload: Multipart) -> actix_web::Result<HttpResponse> {
    debug!("classification request received");
    let mut pdf_data = Vec::new();
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
    Ok(HttpResponse::Ok().json(Classification { regress: is_regress }))
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting classifier service");
    HttpServer::new(|| App::new().route("/classify", web::post().to(classify)))
        .bind(("0.0.0.0", 8084))?
        .run()
        .await
}
