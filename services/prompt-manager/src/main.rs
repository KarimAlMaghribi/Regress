use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, put},
    Json, Router,
};
use sea_orm::{ActiveModelTrait, ConnectionTrait, Database, DatabaseConnection, EntityTrait, Set};
use serde::{Deserialize, Serialize};
use shared::config::Settings;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

mod model;
use model::Entity as Prompt;
use tracing::{error, info};

async fn health() -> &'static str {
    info!("health check request");
    "OK"
}

#[derive(Serialize)]
struct PromptData {
    id: i32,
    text: String,
    weight: f64,
}

#[derive(Deserialize)]
struct PromptInput {
    text: String,
    #[serde(default = "default_weight")]
    weight: f64,
}

#[derive(Serialize, Debug)]
struct ErrorResponse {
    error: String,
}

fn default_weight() -> f64 {
    1.0
}

async fn list_prompts(
    State(db): State<Arc<DatabaseConnection>>,
) -> Result<Json<Vec<PromptData>>, (StatusCode, Json<ErrorResponse>)> {
    info!("listing prompts");
    let items = Prompt::find().all(&*db).await.map_err(|e| {
        error!("failed to list prompts: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    let texts: Vec<PromptData> = items
        .into_iter()
        .map(|p| PromptData {
            id: p.id,
            text: p.text,
            weight: p.weight,
        })
        .collect();
    info!("loaded {} prompts", texts.len());
    Ok(Json(texts))
}

async fn create_prompt(
    State(db): State<Arc<DatabaseConnection>>,
    Json(input): Json<PromptInput>,
) -> Result<Json<PromptData>, (StatusCode, Json<ErrorResponse>)> {
    info!("creating prompt");
    let mut model: model::ActiveModel = Default::default();
    model.text = Set(input.text);
    model.weight = Set(input.weight);
    let res = model.insert(&*db).await.map_err(|e| {
        error!("failed to create prompt: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    info!(id = res.id, "created prompt");
    Ok(Json(PromptData {
        id: res.id,
        text: res.text,
        weight: res.weight,
    }))
}

async fn update_prompt(
    Path(id): Path<i32>,
    State(db): State<Arc<DatabaseConnection>>,
    Json(input): Json<PromptInput>,
) -> Result<Json<PromptData>, (StatusCode, Json<ErrorResponse>)> {
    info!(id, "updating prompt");
    let Some(mut model) = Prompt::find_by_id(id).one(&*db).await.map_err(|e| {
        error!("failed to find prompt {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?
    else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Not found".into(),
            }),
        ));
    };
    model.text = input.text;
    model.weight = input.weight;
    let active: model::ActiveModel = model.into();
    let res = active.update(&*db).await.map_err(|e| {
        error!("failed to update prompt {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    info!(id = res.id, "updated prompt");
    Ok(Json(PromptData {
        id: res.id,
        text: res.text,
        weight: res.weight,
    }))
}

async fn delete_prompt(
    Path(id): Path<i32>,
    State(db): State<Arc<DatabaseConnection>>,
) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
    info!(id, "deleting prompt");
    let Some(model) = Prompt::find_by_id(id).one(&*db).await.map_err(|e| {
        error!("failed to find prompt {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?
    else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Not found".into(),
            }),
        ));
    };
    let active: model::ActiveModel = model.into();
    active.delete(&*db).await.map_err(|e| {
        error!("failed to delete prompt {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    info!(id, "deleted prompt");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let settings = Settings::new().unwrap_or_else(|_| Settings {
        database_url: "postgres://postgres:postgres@db:5432/regress".into(),
        message_broker_url: String::new(),
        openai_api_key: String::new(),
        class_prompt_id: 0,
    });
    let db: Arc<DatabaseConnection> = Arc::new(Database::connect(&settings.database_url).await?);
    // create table if not exists
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "CREATE TABLE IF NOT EXISTS prompts (id SERIAL PRIMARY KEY, text TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1)",
    ))
    .await?;
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "ALTER TABLE prompts ADD COLUMN IF NOT EXISTS weight REAL DEFAULT 1",
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use sea_orm::{DbBackend, MockDatabase, MockExecResult};
    use tower::ServiceExt; // for `oneshot`

    #[tokio::test]
    async fn health_ok() {
        let app = Router::new().route("/health", get(health));
        let res = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/health")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(res.status().is_success());
    }

    #[tokio::test]
    async fn create_update_weight() {
        let db = Arc::new(
            MockDatabase::new(DbBackend::Postgres)
                .append_exec_results([MockExecResult {
                    last_insert_id: 1,
                    rows_affected: 1,
                }])
                .append_query_results([[model::Model {
                    id: 1,
                    text: "hello".into(),
                    weight: 2.0,
                }]])
                .append_query_results([[model::Model {
                    id: 1,
                    text: "hello".into(),
                    weight: 2.0,
                }]])
                .append_exec_results([MockExecResult {
                    last_insert_id: 0,
                    rows_affected: 1,
                }])
                .append_query_results([[model::Model {
                    id: 1,
                    text: "world".into(),
                    weight: 3.0,
                }]])
                .into_connection(),
        );

        let res = create_prompt(
            State(db.clone()),
            Json(PromptInput {
                text: "hello".into(),
                weight: 2.0,
            }),
        )
        .await
        .unwrap();
        assert_eq!(res.0.weight, 2.0);

        let res = update_prompt(
            Path(1),
            State(db.clone()),
            Json(PromptInput {
                text: "world".into(),
                weight: 3.0,
            }),
        )
        .await
        .unwrap();
        assert_eq!(res.0.weight, 3.0);
    }
}
