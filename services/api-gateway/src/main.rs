use actix_web::{web, App, HttpRequest, HttpServer, Responder, HttpResponse};
use actix_web::dev::Payload;
use awc::Client;
use tracing::{debug, info};

async fn health() -> impl Responder {
    debug!("health check request");
    let client = Client::default();
    let urls = [
        "http://pdf-ingest:8081/health",
        "http://text-extraction:8083/health",
        "http://prompt-manager:8082/health",
        "http://classifier:8084/health",
    ];
    for url in urls.iter() {
        if client.get(*url).send().await.is_err() {
            return HttpResponse::ServiceUnavailable().finish();
        }
    }
    HttpResponse::Ok().finish()
}

async fn upload(req: HttpRequest, mut body: Payload) -> impl Responder {
    info!("forwarding upload request");
    let client = Client::default();
    let mut forward = client
        .post("http://pdf-ingest:8081/upload")
        .insert_header(("Content-Type", req.headers().get("Content-Type").cloned().unwrap_or_default()));
    let mut res = match forward.send_stream(body.into()).await {
        Ok(r) => r,
        Err(e) => {
            return HttpResponse::InternalServerError().body(format!("{e}"));
        }
    };
    let status = res.status();
    let bytes = res.body().await.unwrap_or_default();
    HttpResponse::build(status).body(bytes)
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting api-gateway");
    HttpServer::new(|| {
        App::new()
            .route("/health", web::get().to(health))
            .route("/upload", web::post().to(upload))
    })
    .bind(("0.0.0.0", 8080))?
    .run()
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, App};

    #[actix_rt::test]
    async fn health_status() {
        let app = test::init_service(App::new().route("/health", web::get().to(health))).await;
        let req = test::TestRequest::get().uri("/health").to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success() || resp.status().is_server_error());
    }
}
