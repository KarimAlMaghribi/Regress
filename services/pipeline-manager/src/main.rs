use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, put},
    Json, Router,
};
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, Database, DatabaseConnection, EntityTrait, Set,
};
use serde::{Deserialize, Serialize};
use shared::config::Settings;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

mod model;
use model::pipeline::{Entity as PipelineEntity, ActiveModel as PipelineActiveModel};
use tracing::{error, info};

async fn health() -> &'static str {
    info!("health check request");
    "OK"
}

#[derive(Serialize)]
struct PipelineData {
    id: i32,
    name: String,
    data: serde_json::Value,
}

#[derive(Deserialize)]
struct PipelineInput {
    name: String,
    data: serde_json::Value,
}

#[derive(Serialize, Debug)]
struct ErrorResponse {
    error: String,
}

async fn list_pipelines(
    State(db): State<Arc<DatabaseConnection>>,
) -> Result<Json<Vec<PipelineData>>, (StatusCode, Json<ErrorResponse>)> {
    info!("listing pipelines");
    let items = PipelineEntity::find().all(&*db).await.map_err(|e| {
        error!("failed to list pipelines: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e.to_string() }),
        )
    })?;
    Ok(Json(
        items
            .into_iter()
            .map(|p| PipelineData { id: p.id, name: p.name, data: p.data })
            .collect(),
    ))
}

async fn create_pipeline(
    State(db): State<Arc<DatabaseConnection>>,
    Json(input): Json<PipelineInput>,
) -> Result<Json<PipelineData>, (StatusCode, Json<ErrorResponse>)> {
    info!("creating pipeline");
    let mut model: PipelineActiveModel = Default::default();
    model.name = Set(input.name);
    model.data = Set(input.data);
    let res = model.insert(&*db).await.map_err(|e| {
        error!("failed to create pipeline: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e.to_string() }),
        )
    })?;
    Ok(Json(PipelineData { id: res.id, name: res.name, data: res.data }))
}

async fn update_pipeline(
    Path(id): Path<i32>,
    State(db): State<Arc<DatabaseConnection>>,
    Json(input): Json<PipelineInput>,
) -> Result<Json<PipelineData>, (StatusCode, Json<ErrorResponse>)> {
    info!(id, "updating pipeline");
    let Some(mut model) = PipelineEntity::find_by_id(id).one(&*db).await.map_err(|e| {
        error!("failed to find pipeline {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e.to_string() }),
        )
    })? else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse { error: "Not found".into() }),
        ));
    };
    model.name = input.name;
    model.data = input.data;
    let active: PipelineActiveModel = model.into();
    let res = active.update(&*db).await.map_err(|e| {
        error!("failed to update pipeline {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e.to_string() }),
        )
    })?;
    Ok(Json(PipelineData { id: res.id, name: res.name, data: res.data }))
}

async fn delete_pipeline(
    Path(id): Path<i32>,
    State(db): State<Arc<DatabaseConnection>>,
) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
    info!(id, "deleting pipeline");
    let Some(model) = PipelineEntity::find_by_id(id).one(&*db).await.map_err(|e| {
        error!("failed to find pipeline {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e.to_string() }),
        )
    })? else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse { error: "Not found".into() }),
        ));
    };
    let active: PipelineActiveModel = model.into();
    active.delete(&*db).await.map_err(|e| {
        error!("failed to delete pipeline {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e.to_string() }),
        )
    })?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();
    let settings = Settings::new().unwrap_or_else(|_| Settings {
        database_url: "postgres://localhost/regress".into(),
        message_broker_url: String::new(),
        openai_api_key: String::new(),
        class_prompt_id: 0,
    });
    let db: Arc<DatabaseConnection> = Arc::new(Database::connect(&settings.database_url).await?);

    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "CREATE TABLE IF NOT EXISTS pipelines (id SERIAL PRIMARY KEY, name TEXT NOT NULL, data JSONB NOT NULL)",
    ))
    .await?;

    let app = Router::new()
        .route("/health", get(health))
        .route("/pipelines", get(list_pipelines).post(create_pipeline))
        .route("/pipelines/:id", put(update_pipeline).delete(delete_pipeline))
        .with_state(db.clone())
        .layer(CorsLayer::permissive());
    info!("starting pipeline-manager");
    axum::Server::bind(&"0.0.0.0:8087".parse::<std::net::SocketAddr>()?)
        .serve(app.into_make_service())
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use sea_orm::{DbBackend, MockDatabase, MockExecResult};
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_ok() {
        let app = Router::new().route("/health", get(health));
        let res = app
            .oneshot(axum::http::Request::builder().uri("/health").body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(res.status().is_success());
    }

    #[tokio::test]
    async fn create_update_pipeline_route() {
        let db = Arc::new(
            MockDatabase::new(DbBackend::Postgres)
                .append_exec_results([MockExecResult { last_insert_id: 1, rows_affected: 1 }])
                .append_query_results([[model::PipelineModel {
                    id: 1,
                    name: "p".into(),
                    data: serde_json::json!({"a":1}),
                }]])
                .append_query_results([[model::PipelineModel {
                    id: 1,
                    name: "p".into(),
                    data: serde_json::json!({"a":1}),
                }]])
                .append_exec_results([MockExecResult { last_insert_id: 0, rows_affected: 1 }])
                .append_query_results([[model::PipelineModel {
                    id: 1,
                    name: "p2".into(),
                    data: serde_json::json!({"b":2}),
                }]])
                .into_connection(),
        );

        let res = create_pipeline(
            State(db.clone()),
            Json(PipelineInput { name: "p".into(), data: serde_json::json!({"a":1}) }),
        )
        .await
        .unwrap();
        assert_eq!(res.0.name, "p");

        let res = update_pipeline(
            Path(1),
            State(db.clone()),
            Json(PipelineInput { name: "p2".into(), data: serde_json::json!({"b":2}) }),
        )
        .await
        .unwrap();
        assert_eq!(res.0.name, "p2");
    }
}

