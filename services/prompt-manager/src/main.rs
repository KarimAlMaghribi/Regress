use axum::{routing::{get, post, put, delete}, Router, Json, extract::{State, Path}};
use tower_http::cors::CorsLayer;
use sea_orm::{Database, DatabaseConnection, EntityTrait, ConnectionTrait, ActiveModelTrait, Set};
use serde::{Deserialize, Serialize};
use shared::config::Settings;

mod model;
use model::Entity as Prompt;
use tracing::{debug, info};

async fn health() -> &'static str {
    debug!("health check request");
    "OK"
}

#[derive(Serialize)]
struct PromptData {
    id: i32,
    text: String,
}

#[derive(Deserialize)]
struct PromptInput {
    text: String,
}

async fn list_prompts(State(db): State<DatabaseConnection>) -> Result<Json<Vec<PromptData>>, axum::http::StatusCode> {
    debug!("listing prompts");
    let items = Prompt::find()
        .all(&db)
        .await
        .map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    let texts = items.into_iter().map(|p| PromptData { id: p.id, text: p.text }).collect();
    info!("loaded {} prompts", texts.len());
    Ok(Json(texts))
}

async fn create_prompt(State(db): State<DatabaseConnection>, Json(input): Json<PromptInput>) -> Result<Json<PromptData>, axum::http::StatusCode> {
    debug!("creating prompt");
    let mut model: model::ActiveModel = Default::default();
    model.text = Set(input.text);
    let res = model.insert(&db).await.map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    info!(id = res.id, "created prompt");
    Ok(Json(PromptData { id: res.id, text: res.text }))
}

async fn update_prompt(Path(id): Path<i32>, State(db): State<DatabaseConnection>, Json(input): Json<PromptInput>) -> Result<Json<PromptData>, axum::http::StatusCode> {
    debug!(id, "updating prompt");
    let Some(mut model) = Prompt::find_by_id(id).one(&db).await.map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)? else {
        return Err(axum::http::StatusCode::NOT_FOUND);
    };
    model.text = input.text;
    let active: model::ActiveModel = model.into();
    let res = active.update(&db).await.map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    info!(id = res.id, "updated prompt");
    Ok(Json(PromptData { id: res.id, text: res.text }))
}

async fn delete_prompt(Path(id): Path<i32>, State(db): State<DatabaseConnection>) -> Result<(), axum::http::StatusCode> {
    debug!(id, "deleting prompt");
    let Some(model) = Prompt::find_by_id(id).one(&db).await.map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)? else {
        return Err(axum::http::StatusCode::NOT_FOUND);
    };
    let active: model::ActiveModel = model.into();
    active.delete(&db).await.map_err(|_| axum::http::StatusCode::INTERNAL_SERVER_ERROR)?;
    info!(id, "deleted prompt");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let settings = Settings::new().unwrap_or_else(|_| Settings {
        database_url: "postgres://postgres:postgres@db:5432/regress".into(),
        message_broker_url: String::new(),
    });
    let db: DatabaseConnection = Database::connect(&settings.database_url).await?;
    // create table if not exists
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "CREATE TABLE IF NOT EXISTS prompts (id SERIAL PRIMARY KEY, text TEXT NOT NULL)",
    ))
    .await?;

    let app = Router::new()
        .route("/health", get(health))
        .route("/prompts", get(list_prompts).post(create_prompt))
        .route("/prompts/:id", put(update_prompt).delete(delete_prompt))
        .with_state(db.clone())
        .layer(CorsLayer::permissive());
    info!("starting prompt-manager");
    axum::Server::bind(&"0.0.0.0:8082".parse::<std::net::SocketAddr>()?)
        .serve(app.into_make_service())
        .await?;
    Ok(())
}
