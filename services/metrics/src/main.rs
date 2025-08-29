use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use shared::config::Settings;
use tracing::{error, info, warn};

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
    use tokio_postgres::types::ToSql;

    info!("loading metrics");

    let mut sql =
        String::from("SELECT run_time, metrics->>'accuracy', metrics->>'cost' FROM classifications");

    let mut values: Vec<Box<dyn ToSql + Sync>> = Vec::new();
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
        // l ist i64 -> keine SQL Injection
        sql.push_str(&format!(" LIMIT {}", l));
    }

    let params: Vec<&(dyn ToSql + Sync)> = values.iter().map(|v| &**v).collect();

    let rows = db
        .query(&sql, &params)
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    let items: Vec<Metric> = rows
        .into_iter()
        .map(|r| Metric {
            timestamp: r.get(0),
            accuracy: r
                .get::<_, Option<String>>(1)
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.0),
            cost: r
                .get::<_, Option<String>>(2)
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.0),
        })
        .collect();

    Ok(HttpResponse::Ok().json(items))
}

mod db_connect {
    use tokio::time::{sleep, Duration};
    use tokio_postgres::{Client, NoTls};
    use tracing::{error, info, warn};

    // sehr einfache Parser für Host/Port aus der URL (ohne zusätzliche Crates)
    fn parse_host_port(url: &str) -> (Option<String>, Option<u16>) {
        // Format: scheme://[user[:pwd]@]host[:port]/...
        if let Some(after_scheme) = url.splitn(2, "://").nth(1) {
            let after_at = after_scheme.splitn(2, '@').last().unwrap_or(after_scheme);
            let host_port = after_at.splitn(2, '/').next().unwrap_or(after_at);
            let mut it = host_port.splitn(2, ':');
            let host = it.next().map(|s| s.to_string());
            let port = it
                .next()
                .and_then(|p| p.parse::<u16>().ok());
            (host, port)
        } else {
            (None, None)
        }
    }

    fn want_tls(database_url: &str) -> bool {
        let q = match database_url.splitn(2, '?').nth(1) {
            Some(q) => q,
            None => true, // kein sslmode angegeben -> TLS versuchen (failsafes Verhalten)
        };
        for pair in q.split('&') {
            let mut it = pair.splitn(2, '=');
            let k = it.next().unwrap_or("");
            let v = it.next().unwrap_or("");
            if k.eq_ignore_ascii_case("sslmode") {
                return !v.eq_ignore_ascii_case("disable");
            }
        }
        true
    }

    pub async fn connect_with_retry(database_url: &str) -> Client {
        // Preflight-DNS (nur Logging, kein Abort)
        let (host_opt, port_opt) = parse_host_port(database_url);
        if let Some(h) = host_opt.as_deref() {
            let p = port_opt.unwrap_or(5432);
            match tokio::net::lookup_host((h, p)).await {
                Ok(mut addrs) => {
                    if let Some(a) = addrs.next() {
                        info!("DB DNS ok: {} -> {}", h, a);
                    } else {
                        warn!("DB DNS: {} hat keine Adressen geliefert", h);
                    }
                }
                Err(e) => warn!("DB DNS-Auflösung fehlgeschlagen ({}:{}): {}", h, p, e),
            }
        }

        let mut backoff = 1u64;
        loop {
            if want_tls(database_url) {
                // Erst TLS versuchen
                match native_tls::TlsConnector::builder().build() {
                    Ok(tls) => {
                        let tls = postgres_native_tls::MakeTlsConnector::new(tls);
                        match tokio_postgres::connect(database_url, tls).await {
                            Ok((client, connection)) => {
                                tokio::spawn(async move {
                                    if let Err(e) = connection.await {
                                        error!(%e, "postgres connection task ended with error (TLS)");
                                    }
                                });
                                info!("Connected to PostgreSQL (TLS).");
                                return client;
                            }
                            Err(e) => {
                                error!(%e, "DB connect (TLS) failed; fallback to NoTLS");
                            }
                        }
                    }
                    Err(e) => warn!(%e, "building TLS connector failed; falling back to NoTLS"),
                }
            }

            // NoTLS (aktuelles Setup: sslmode=disable)
            match tokio_postgres::connect(database_url, NoTls).await {
                Ok((client, connection)) => {
                    tokio::spawn(async move {
                        if let Err(e) = connection.await {
                            error!(%e, "postgres connection task ended with error (NoTLS)");
                        }
                    });
                    info!("Connected to PostgreSQL (NoTLS).");
                    return client;
                }
                Err(e) => {
                    error!(%e, "DB connect (NoTLS) failed");
                    let wait = backoff.min(10);
                    sleep(Duration::from_secs(wait)).await;
                    backoff = (backoff + 1).min(10);
                }
            }
        }
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting metrics service");

    let settings = match Settings::new() {
        Ok(s) => s,
        Err(e) => {
            error!(%e, "failed to load settings");
            std::process::exit(1);
        }
    };

    // Robust verbinden (kein unwrap, TLS/NoTLS-Autowahl)
    let db_client = db_connect::connect_with_retry(&settings.database_url).await;

    // Schema sicherstellen; Fehler loggen statt panic
    if let Err(e) = db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS classifications ( \
                id SERIAL PRIMARY KEY, \
                run_time TIMESTAMPTZ DEFAULT now(), \
                file_name TEXT, \
                prompts TEXT, \
                regress BOOLEAN, \
                metrics JSONB NOT NULL, \
                responses JSONB NOT NULL, \
                error TEXT \
            )",
            &[],
        )
        .await
    {
        error!(%e, "failed to create classifications table");
    }

    if let Err(e) = db_client
        .execute(
            "ALTER TABLE classifications ADD COLUMN IF NOT EXISTS error TEXT",
            &[],
        )
        .await
    {
        error!(%e, "failed to ensure error column");
    }

    if let Err(e) = db_client
        .execute(
            "ALTER TABLE classifications ALTER COLUMN regress DROP NOT NULL",
            &[],
        )
        .await
    {
        error!(%e, "failed to relax NOT NULL on regress (can be benign)");
    }

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

    #[actix_web::test]
    async fn health_ok() {
        let app = test::init_service(App::new().route("/health", web::get().to(health))).await;
        let req = test::TestRequest::get().uri("/health").to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());
    }
}
