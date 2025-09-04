use actix_cors::Cors;
use actix_web::web::Payload;
use actix_web::{web, App, HttpRequest, HttpResponse, HttpServer};
use awc::Client;
use futures_util::future;
use tracing::info;

/// Querystring anhängen, falls vorhanden
fn with_qs(base: &str, req: &HttpRequest) -> String {
    let qs = req.query_string();
    if qs.is_empty() {
        base.to_owned()
    } else {
        format!("{base}?{qs}")
    }
}

async fn health() -> HttpResponse {
    info!("health check request");
    let client = Client::default();
    let urls = [
        "http://pdf-ingest:8081/health",
        "http://text-extraction:8083/health",
        "http://prompt-manager:8082/health",
        "http://metrics:8085/health",
    ];

    let checks = urls.iter().map(|u| client.get(*u).send());
    let results = future::join_all(checks).await;

    let any_bad = results.iter().any(|r| {
        r.as_ref()
            .map(|res| !res.status().is_success())
            .unwrap_or(true)
    });

    if any_bad {
        HttpResponse::ServiceUnavailable().finish()
    } else {
        HttpResponse::Ok().finish()
    }
}

async fn proxy(req: HttpRequest, body: Payload, url: &str) -> HttpResponse {
    let client = Client::default();
    let mut forward = client.request(req.method().clone(), url);
    for (h, v) in req.headers().iter() {
        forward = forward.insert_header((h.clone(), v.clone()));
    }
    let mut res = match forward.send_stream(body).await {
        Ok(r) => r,
        Err(e) => return HttpResponse::InternalServerError().body(e.to_string()),
    };
    let status = res.status();
    let bytes = res.body().await.unwrap_or_default();
    HttpResponse::build(status).body(bytes)
}

/// POST /upload  -> pdf-ingest:/upload
async fn upload(req: HttpRequest, body: Payload) -> HttpResponse {
    info!("forwarding upload request");
    proxy(req, body, "http://pdf-ingest:8081/upload").await
}

/// GET /uploads -> pdf-ingest:/uploads
async fn uploads(req: HttpRequest, body: Payload) -> HttpResponse {
    let url = with_qs("http://pdf-ingest:8081/uploads", &req);
    proxy(req, body, url.as_str()).await
}

/// GET /uploads/{id}/extract -> pdf-ingest:/uploads/{id}/extract
async fn upload_extract(req: HttpRequest, body: Payload) -> HttpResponse {
    let id = req.match_info().query("id");
    let url = with_qs(&format!("http://pdf-ingest:8081/uploads/{id}/extract"), &req);
    proxy(req, body, url.as_str()).await
}

/// GET/DELETE /pdf/{id} -> pdf-ingest:/pdf/{id}
async fn pdf_get_or_delete(req: HttpRequest, body: Payload) -> HttpResponse {
    let id = req.match_info().query("id");
    let url = with_qs(&format!("http://pdf-ingest:8081/pdf/{id}"), &req);
    proxy(req, body, url.as_str()).await
}

/// GET /te/texts -> text-extraction:/texts
async fn te_texts(req: HttpRequest, body: Payload) -> HttpResponse {
    let url = with_qs("http://text-extraction:8083/texts", &req);
    proxy(req, body, url.as_str()).await
}

/// POST /te/analyze -> text-extraction:/analyze
async fn te_analyze(req: HttpRequest, body: Payload) -> HttpResponse {
    let url = with_qs("http://text-extraction:8083/analyze", &req);
    proxy(req, body, url.as_str()).await
}

/// /prompts[...] -> prompt-manager:/prompts[...]
async fn prompts(req: HttpRequest, body: Payload) -> HttpResponse {
    let tail = req.match_info().query("tail");
    let base = if tail.is_empty() {
        "http://prompt-manager:8082/prompts".to_string()
    } else {
        format!("http://prompt-manager:8082/prompts/{tail}")
    };
    let url = with_qs(&base, &req);
    info!(%url, "forwarding prompt-manager request");
    proxy(req, body, url.as_str()).await
}

/// /pipelines (root) -> pipeline-api:/pipelines
async fn pipelines_root(req: HttpRequest, body: Payload) -> HttpResponse {
    let url = with_qs("http://pipeline-api:8084/pipelines", &req);
    proxy(req, body, url.as_str()).await
}

/// /pipelines[...] -> pipeline-api:/pipelines[...]
async fn pipelines(req: HttpRequest, body: Payload) -> HttpResponse {
    let tail = req.match_info().query("tail");
    let base = if tail.is_empty() {
        "http://pipeline-api:8084/pipelines".to_string()
    } else {
        format!("http://pipeline-api:8084/pipelines/{tail}")
    };
    let url = with_qs(&base, &req);
    proxy(req, body, url.as_str()).await
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting api-gateway");
    HttpServer::new(|| {
        App::new()
            .wrap(Cors::permissive())
            // health
            .route("/health", web::get().to(health))
            // pdf-ingest
            .route("/upload", web::post().to(upload))
            .route("/uploads", web::get().to(uploads))
            .route("/uploads/{id}/extract", web::get().to(upload_extract))
            .service(
                web::resource("/pdf/{id}")
                    .route(web::get().to(pdf_get_or_delete))
                    .route(web::delete().to(pdf_get_or_delete)),
            )
            // text-extraction
            .route("/te/texts", web::get().to(te_texts))
            .route("/te/analyze", web::post().to(te_analyze))
            // prompts
            .service(web::resource("/prompts/{tail:.*}").route(web::to(prompts)))
            // pipelines
            .route("/pipelines", web::to(pipelines_root))
            .service(web::resource("/pipelines/{tail:.*}").route(web::to(pipelines)))
    })
        .bind(("0.0.0.0", 8080))?
        .run()
        .await
}
