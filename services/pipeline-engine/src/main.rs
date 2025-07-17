use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use serde::Serialize;
use shared::{pipeline_executor::PipelineExecutor, pipeline_graph::PipelineGraph};

async fn health() -> impl Responder {
    "OK"
}

#[derive(Serialize)]
struct HistoryEntry {
    prompt_id: String,
    result: bool,
    score: f64,
    answer: Option<String>,
}

#[derive(Serialize)]
struct PipelineRunResult {
    score: f64,
    label: String,
    history: Vec<HistoryEntry>,
}

async fn run_pipeline(graph: web::Json<PipelineGraph>) -> impl Responder {
    let mut exec = PipelineExecutor::new(graph.into_inner());
    exec.run();
    let (score, label) = exec.get_result().unwrap_or((0.0, String::new()));
    let history = exec
        .history()
        .iter()
        .map(|(id, data)| HistoryEntry {
            prompt_id: id.clone(),
            result: data.result,
            score: data.score,
            answer: data.answer.clone(),
        })
        .collect();
    HttpResponse::Ok().json(PipelineRunResult {
        score,
        label,
        history,
    })
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    HttpServer::new(|| {
        App::new()
            .wrap(Cors::permissive())
            .route("/health", web::get().to(health))
            .route("/pipeline/run", web::post().to(run_pipeline))
    })
    .bind(("0.0.0.0", 8084))?
    .run()
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test as actix_test, App};
    use shared::pipeline_graph::example_pipeline;

    #[actix_web::test]
    async fn health_ok() {
        let app =
            actix_test::init_service(App::new().route("/health", web::get().to(health))).await;
        let req = actix_test::TestRequest::get().uri("/health").to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert!(resp.status().is_success());
    }

    #[actix_web::test]
    async fn run_pipeline_route() {
        let app = actix_test::init_service(
            App::new().route("/pipeline/run", web::post().to(run_pipeline)),
        )
        .await;
        let req = actix_test::TestRequest::post()
            .uri("/pipeline/run")
            .set_json(&example_pipeline())
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert!(resp.status().is_success());
    }
}
