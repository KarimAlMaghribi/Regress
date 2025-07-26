use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use awc::Client as HttpClient;
use chrono::Utc;
use native_tls::TlsConnector;
use postgres_native_tls::MakeTlsConnector;
use rdkafka::{
    consumer::{Consumer, StreamConsumer},
    producer::{FutureProducer, FutureRecord},
    ClientConfig,
    message::Message,
};
use shared::{
    config::Settings,
    dto::{LayoutExtracted, PipelineRunResult, PromptResult},
    openai_executor::OpenAIExecutor,
    pipeline_executor::PipelineExecutor,
    pipeline_graph::{PipelineGraph, Status},
};
use std::sync::Arc;
use std::time::Duration;
use tokio_postgres::Client;

async fn health() -> impl Responder {
    "OK"
}

async fn get_run(path: web::Path<i32>, db: web::Data<Client>) -> impl Responder {
    let id = path.into_inner();
    if let Ok(row) = db
        .query_one("SELECT result FROM pipeline_runs WHERE id=$1", &[&id])
        .await
    {
        let mut result: PipelineRunResult = serde_json::from_value(row.get(0)).unwrap();
        result.run_id = Some(id.to_string());
        if let Ok(rows) = db
            .query(
                "SELECT prompt_id,prompt_type,status,result,score,answer,source,attempt,started_at,finished_at FROM prompt_results WHERE run_id=$1 ORDER BY id",
                &[&id],
            )
            .await
        {
            let history = rows
                .into_iter()
                .map(|r| PromptResult {
                    prompt_id: r.get(0),
                    prompt_type: r.get(1),
                    status: match r.get::<_, String>(2).as_str() {
                        "Pending" => Status::Pending,
                        "Running" => Status::Running,
                        "Done" => Status::Done,
                        _ => Status::Skipped,
                    },
                    result: r.get(3),
                    score: r.get(4),
                    answer: r.get(5),
                    source: r.get(6),
                    attempt: r.get::<_, Option<i32>>(7).map(|v| v as u8),
                    started_at: r.get(8),
                    finished_at: r.get(9),
                })
                .collect();
            result.history = history;
        }
        return HttpResponse::Ok().json(result);
    }
    HttpResponse::NotFound().finish()
}

async fn start_kafka(db: Arc<Client>, producer: FutureProducer, settings: Settings) {
    let consumer: StreamConsumer = ClientConfig::new()
        .set("group.id", "pipeline-runner")
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
        .unwrap();
    consumer.subscribe(&["layout-extracted"]).unwrap();

    let http = HttpClient::new();
    let openai = OpenAIExecutor::new(settings.openai_api_key.clone());

    loop {
        match consumer.recv().await {
            Err(e) => println!("kafka error: {e}"),
            Ok(m) => {
                if let Some(Ok(payload)) = m.payload_view::<str>() {
                    if let Ok(event) = serde_json::from_str::<LayoutExtracted>(payload) {
                        if let Ok(mut resp) = http
                            .get("http://pipeline-manager:8087/pipelines/active")
                            .send()
                            .await
                        {
                            if let Ok(graph) = resp.json::<PipelineGraph>().await {
                                let mut exec = PipelineExecutor::new(graph);
                                exec.run_with_openai(&openai, &event.blocks).await;
                                let (score, label) = exec.get_result();
                                let history: Vec<PromptResult> = exec
                                    .history()
                                    .iter()
                                    .map(|(id, data, attempt, ptype)| PromptResult {
                                        prompt_id: id.clone(),
                                        prompt_type: ptype.as_str().into(),
                                        status: Status::Done,
                                        result: Some(data.result),
                                        score: Some(data.score),
                                        answer: data.answer.clone(),
                                        source: data.source.clone(),
                                        attempt: Some(*attempt),
                                        started_at: data.started_at.clone(),
                                        finished_at: data.finished_at.clone(),
                                    })
                                    .collect();
                                let mut result = PipelineRunResult {
                                    score,
                                    label,
                                    history: history.clone(),
                                    stage_scores: Some(exec.stage_scores().clone()),
                                    run_id: None,
                                    started_at: Some(Utc::now().to_rfc3339()),
                                    finished_at: Some(Utc::now().to_rfc3339()),
                                };
                                if let Ok(row) = db
                                    .query_one(
                                        "INSERT INTO pipeline_runs (result) VALUES ($1) RETURNING id",
                                        &[&serde_json::to_value(&result).unwrap()],
                                    )
                                    .await
                                {
                                    let id: i32 = row.get(0);
                                    result.run_id = Some(id.to_string());
                                    let _ = db
                                        .execute(
                                            "UPDATE pipeline_runs SET result=$2 WHERE id=$1",
                                            &[&id, &serde_json::to_value(&result).unwrap()],
                                        )
                                        .await;
                                    for r in &history {
                                        let _ = db
                                            .execute(
                                                "INSERT INTO prompt_results (run_id,prompt_id,prompt_type,status,result,score,answer,source,attempt,started_at,finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
                                                &[&id, &r.prompt_id, &r.prompt_type, &format!("{:?}", r.status), &r.result, &r.score, &r.answer, &r.source, &r.attempt.map(|v| v as i32), &r.started_at, &r.finished_at],
                                            )
                                            .await;
                                    }
                                    let payload = serde_json::to_string(&result).unwrap();
                                    let _ = producer
                                        .send(
                                            FutureRecord::to("pipeline-result").payload(&payload).key(&()),
                                            Duration::from_secs(0),
                                        )
                                        .await;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
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
    tokio::spawn(async move { let _ = connection.await; });
    db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS pipeline_runs (id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT now(), result JSONB NOT NULL)",
            &[],
        )
        .await
        .unwrap();
    db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS prompt_results (id SERIAL PRIMARY KEY, run_id INTEGER REFERENCES pipeline_runs(id), prompt_id TEXT, prompt_type TEXT, status TEXT, result BOOLEAN, score REAL, answer TEXT, source TEXT, attempt INTEGER, started_at TEXT, finished_at TEXT)",
            &[],
        )
        .await
        .unwrap();
    let prod: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
        .unwrap();
    let db_arc = Arc::new(db_client);
    actix_web::rt::spawn(start_kafka(db_arc.clone(), prod.clone(), settings.clone()));
    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(db_arc.clone()))
            .wrap(Cors::permissive())
            .route("/health", web::get().to(health))
            .route("/runs/{id}", web::get().to(get_run))
    })
    .bind(("0.0.0.0", 8084))?
    .run()
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test as actix_test, App};

    #[actix_web::test]
    async fn health_ok() {
        let app = actix_test::init_service(App::new().route("/health", web::get().to(health))).await;
        let req = actix_test::TestRequest::get().uri("/health").to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert!(resp.status().is_success());
    }
}
