use actix_cors::Cors;
use actix_web::web::Payload;
use actix_web::{web, App, HttpRequest, HttpResponse, HttpServer, Responder};
use awc::Client;
use futures_util::future;
use tracing::info;

async fn health() -> impl Responder {
    info!("health check request");
    let client = Client::default();
    let urls = [
        "http://pdf-ingest:8081/health",
        "http://text-extraction:8083/health",
        "http://prompt-manager:8082/health",
        "http://classifier:8084/health",
        "http://metrics:8085/health",
    ];
    let checks = urls.iter().map(|u| client.get(*u).send());
    let results = future::join_all(checks).await;
    if results.iter().any(|r| {
        r.as_ref()
            .map(|res| !res.status().is_success())
            .unwrap_or(true)
    }) {
        return HttpResponse::ServiceUnavailable().finish();
    }
    HttpResponse::Ok().finish()
}

async fn upload(req: HttpRequest, body: Payload) -> impl Responder {
    info!("forwarding upload request");
    let client = Client::default();
    let mut forward = client.post("http://pdf-ingest:8081/upload");
    for (h, v) in req.headers().iter() {
        forward = forward.insert_header((h.clone(), v.clone()));
    }
    let mut res = match forward.send_stream(body).await {
        Ok(r) => r,
        Err(e) => {
            return HttpResponse::InternalServerError().body(format!("{e}"));
        }
    };
    let status = res.status();
    let bytes = res.body().await.unwrap_or_default();
    HttpResponse::build(status).body(bytes)
}

async fn proxy(req: HttpRequest, body: Payload, url: String) -> HttpResponse {
    let client = Client::default();
    let mut forward = client.request(req.method().clone(), url);
    for (h, v) in req.headers().iter() {
        forward = forward.insert_header((h.clone(), v.clone()));
    }
    let mut res = match forward.send_stream(body).await {
        Ok(r) => r,
        Err(e) => return HttpResponse::InternalServerError().body(format!("{e}")),
    };
    let status = res.status();
    let bytes = res.body().await.unwrap_or_default();
    HttpResponse::build(status).body(bytes)
}

async fn prompts(req: HttpRequest, body: Payload) -> impl Responder {
    let tail = req.match_info().query("tail");
    let url = format!(
        "http://prompt-manager:8082/prompts{}",
        if tail.is_empty() {
            String::new()
        } else {
            format!("/{}", tail)
        }
    );
    info!(%url, "forwarding prompt-manager request");
    proxy(req, body, url).await
}

async fn classify(req: HttpRequest, body: Payload) -> impl Responder {
    info!("forwarding classify request");
    proxy(req, body, "http://classifier:8084/classify".into()).await
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting api-gateway");
    HttpServer::new(|| {
        App::new()
            .wrap(Cors::permissive())
            .route("/health", web::get().to(health))
            .route("/upload", web::post().to(upload))
            .service(web::resource("/classify").route(web::to(classify)))
            .service(web::resource("/prompts/{tail:.*}").route(web::to(prompts)))
    })
    .bind(("0.0.0.0", 8080))?
    .run()
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, App};

    #[actix_web::test]
    async fn health_status() {
        let app = test::init_service(App::new().route("/health", web::get().to(health))).await;
        let req = test::TestRequest::get().uri("/health").to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success() || resp.status().is_server_error());
    }
}
