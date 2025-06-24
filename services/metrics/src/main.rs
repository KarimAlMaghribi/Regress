use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use shared::config::Settings;
use tracing::{debug, info};

#[derive(Serialize)]
struct Metric {
    timestamp: DateTime<Utc>,
    accuracy: f64,
    cost: f64,
}

async fn health() -> impl Responder {
    "OK"
}

#[derive(Default, Deserialize)]
struct Query {
    start: Option<DateTime<Utc>>, 
    end: Option<DateTime<Utc>>, 
    limit: Option<i64>,
}

async fn metrics(
    db: web::Data<tokio_postgres::Client>,
    query: web::Query<Query>,
) -> actix_web::Result<HttpResponse> {
    debug!("loading metrics");
    let mut sql = String::from("SELECT run_time, metrics->>'accuracy', metrics->>'cost' FROM classifications");
    let mut values: Vec<Box<dyn tokio_postgres::types::ToSql + Sync>> = Vec::new();
    let mut clauses: Vec<String> = Vec::new();
    if let Some(start) = query.start {
        clauses.push(format!("run_time >= ${}", values.len() + 1));
        values.push(Box::new(start));
    }
    if let Some(end) = query.end {
        clauses.push(format!("run_time <= ${}", values.len() + 1));
        values.push(Box::new(end));
    }
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }
    sql.push_str(" ORDER BY run_time DESC");
    if let Some(l) = query.limit {
        sql.push_str(&format!(" LIMIT {}", l));
    }
    let rows = db
        .query(&sql, &values.iter().map(|v| &**v).collect::<Vec<_>>())
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let items: Vec<Metric> = rows
        .into_iter()
        .map(|r| Metric {
            timestamp: r.get(0),
            accuracy: r.get::<_, Option<String>>(1).and_then(|v| v.parse().ok()).unwrap_or(0.0),
            cost: r.get::<_, Option<String>>(2).and_then(|v| v.parse().ok()).unwrap_or(0.0),
        })
        .collect();
    Ok(HttpResponse::Ok().json(items))
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting metrics service");
    let settings = Settings::new().unwrap();
    let (db_client, connection) = tokio_postgres::connect(&settings.database_url, tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS classifications (id SERIAL PRIMARY KEY, run_time TIMESTAMPTZ DEFAULT now(), file_name TEXT, prompts TEXT, regress BOOLEAN NOT NULL, metrics JSONB NOT NULL, responses JSONB NOT NULL)",
            &[],
        )
        .await
        .unwrap();
    let db = web::Data::new(db_client);
    HttpServer::new(move || {
        App::new()
            .wrap(Cors::permissive())
            .app_data(db.clone())
            .route("/metrics", web::get().to(metrics))
            .route("/health", web::get().to(health))
    })
    .bind(("0.0.0.0", 8085))?
    .run()
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, App};

    #[actix_rt::test]
    async fn health_ok() {
        let app = test::init_service(App::new().route("/health", web::get().to(health))).await;
        let req = test::TestRequest::get().uri("/health").to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());
    }
}
