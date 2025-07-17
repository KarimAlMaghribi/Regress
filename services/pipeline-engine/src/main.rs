use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use chrono::Utc;
use native_tls::TlsConnector;
use postgres_native_tls::MakeTlsConnector;
use shared::config::Settings;
use shared::{
    dto::{PipelineRunResult, PromptResult},
    pipeline_executor::PipelineExecutor,
    pipeline_graph::PipelineGraph,
};
use tokio_postgres::Client;

async fn health() -> impl Responder {
    "OK"
}

struct AppState {
    db: Client,
}

async fn run_pipeline(
    graph: web::Json<PipelineGraph>,
    state: web::Data<AppState>,
) -> impl Responder {
    let input_graph = graph.into_inner();
    let mut exec = PipelineExecutor::new(input_graph.clone());
    let started = Utc::now();
    exec.run();
    let finished = Utc::now();
    let (score, label) = exec.get_result().unwrap_or((0.0, String::new()));
    let history: Vec<PromptResult> = exec
        .history()
        .iter()
        .map(|(id, data, attempt)| PromptResult {
            prompt_id: id.clone(),
            prompt_type: String::new(),
            status: "done".into(),
            result: Some(data.result),
            score: Some(data.score),
            answer: data.answer.clone(),
            source: data.source.clone(),
            attempt: Some(*attempt),
            started_at: None,
            finished_at: None,
        })
        .collect();
    let mut result = PipelineRunResult {
        score,
        label: label.clone(),
        history,
        stage_scores: Some(exec.stage_scores().clone()),
        run_id: None,
        started_at: Some(started.to_rfc3339()),
        finished_at: Some(finished.to_rfc3339()),
    };
    // store in db
    if let Ok(json_graph) = serde_json::to_value(&input_graph) {
        if let Ok(json_result) = serde_json::to_value(&result) {
            if let Ok(row) = state
                .db
                .query_one(
                    "INSERT INTO pipeline_runs (input_graph, result) VALUES ($1, $2) RETURNING id",
                    &[&json_graph, &json_result],
                )
                .await
            {
                let id: i32 = row.get(0);
                result.run_id = Some(id.to_string());
            }
        }
    }
    HttpResponse::Ok().json(result)
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    let settings = Settings::new().unwrap();
    let tls = TlsConnector::builder().build().unwrap();
    let connector = MakeTlsConnector::new(tls);
    let (db_client, connection) = tokio_postgres::connect(&settings.database_url, connector)
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });
    db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS pipeline_runs (id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT now(), input_graph JSONB NOT NULL, ocr_text TEXT, result JSONB NOT NULL)",
            &[],
        )
        .await
        .unwrap();
    let data = web::Data::new(AppState { db: db_client });
    HttpServer::new(move || {
        App::new()
            .app_data(data.clone())
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
        let url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://postgres:postgres@localhost/postgres".into());
        let tls_connector = TlsConnector::builder().build().unwrap();
        let connector = MakeTlsConnector::new(tls_connector);
        if let Ok((client, connection)) = tokio_postgres::connect(&url, connector).await {
            tokio::spawn(async move {
                let _ = connection.await;
            });
            client
                .execute(
                    "CREATE TABLE IF NOT EXISTS pipeline_runs (id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT now(), input_graph JSONB NOT NULL, ocr_text TEXT, result JSONB NOT NULL)",
                    &[],
                )
                .await
                .unwrap();

            let app = actix_test::init_service(
                App::new()
                    .app_data(web::Data::new(AppState { db: client }))
                    .route("/pipeline/run", web::post().to(run_pipeline)),
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
}
