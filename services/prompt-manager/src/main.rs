use axum::{routing::get, Router};
use sea_orm::{Database, DatabaseConnection};
use shared::config::Settings;
use tracing::info;

async fn health() -> &'static str {
    "OK"
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let settings = Settings::new().map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let _db: DatabaseConnection = Database::connect(settings.database_url).await?;
    let app = Router::new().route("/health", get(health));
    info!("starting prompt-manager");
    axum::Server::bind(&"0.0.0.0:8082".parse::<std::net::SocketAddr>()?)
        .serve(app.into_make_service())
        .await?;
    Ok(())
}
