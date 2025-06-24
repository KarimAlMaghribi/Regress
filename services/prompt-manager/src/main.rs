use axum::{routing::get, Router, Json, extract::State};
use sea_orm::{Database, DatabaseConnection, EntityTrait, ConnectionTrait};
use shared::config::Settings;

mod model;
use model::Entity as Prompt;
use tracing::info;

async fn health() -> &'static str {
    "OK"
}

async fn list_prompts(State(db): State<DatabaseConnection>) -> Result<Json<Vec<String>>, axum::http::StatusCode> {
    let items = Prompt::find()
        .all(&db)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    let texts = items.into_iter().map(|p| p.text).collect();
    Ok(Json(texts))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let settings = Settings::new().unwrap_or_else(|_| Settings { database_url: "sqlite://prompts.db".into(), message_broker_url: String::new() });
    let db: DatabaseConnection = Database::connect(&settings.database_url).await?;
    // create table if not exists
    db.execute(sea_orm::Statement::from_string(db.get_database_backend(), "CREATE TABLE IF NOT EXISTS prompts (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)".into())).await?;

    let app = Router::new()
        .route("/health", get(health))
        .route("/prompts", get(list_prompts))
        .with_state(db.clone());
    info!("starting prompt-manager");
    axum::Server::bind(&"0.0.0.0:8082".parse::<std::net::SocketAddr>()?)
        .serve(app.into_make_service())
        .await?;
    Ok(())
}
