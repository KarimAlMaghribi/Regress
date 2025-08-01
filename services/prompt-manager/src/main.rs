use axum::{
    extract::{Path, State, Query},
    http::StatusCode,
    routing::{get, put},
    Json, Router,
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, Database, DatabaseConnection, EntityTrait,
    QueryFilter, Set,
};
use serde::{Deserialize, Serialize};
use shared::dto::PromptType;
use shared::config::Settings;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

mod model;
use model::{
    group::{Entity as GroupEntity, Model as GroupModel},
    group_prompt::{
        ActiveModel as GroupPromptActiveModel, Entity as GroupPromptEntity,
        Model as GroupPromptModel,
    },
    prompt::Entity as Prompt,
    pipeline::{Entity as PipelineEntity, ActiveModel as PipelineActiveModel, Model as PipelineModel},
};
use tracing::{error, info, warn};
use tracing_subscriber::{fmt, EnvFilter};

async fn health() -> &'static str {
    info!("health check request");
    "OK"
}

#[derive(Serialize)]
struct PromptData {
    id: i32,
    text: String,
    #[serde(rename = "type")]
    prompt_type: PromptType,
    weight: f64,
    json_key: Option<String>,
    favorite: bool,
}

#[derive(Deserialize)]
struct PromptInput {
    text: String,
    #[serde(default = "default_weight")]
    weight: f64,
    #[serde(default = "default_prompt_type", rename = "type")]
    prompt_type: PromptType,
    json_key: Option<String>,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    group_ids: Vec<i32>,
}

#[derive(Serialize)]
struct GroupData {
    id: i32,
    name: String,
    prompt_ids: Vec<i32>,
    favorite: bool,
}

#[derive(Deserialize)]
struct GroupInput {
    name: String,
    prompt_ids: Vec<i32>,
    #[serde(default)]
    favorite: bool,
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

fn default_weight() -> f64 {
    1.0
}

fn default_prompt_type() -> PromptType {
    PromptType::ExtractionPrompt
}

#[derive(Deserialize)]
struct ListParams {
    #[serde(rename = "type")]
    r#type: Option<PromptType>,
}

async fn list_prompts(
    State(db): State<Arc<DatabaseConnection>>,
    Query(params): Query<ListParams>,
) -> Result<Json<Vec<PromptData>>, (StatusCode, Json<ErrorResponse>)> {
    info!("listing prompts");
    let mut query = Prompt::find();
    if let Some(t) = params.r#type {
        query = query.filter(model::prompt::Column::PromptType.eq(t.to_string()));
    }
    let items = query.all(&*db).await.map_err(|e| {
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
            prompt_type: p.prompt_type.parse().unwrap_or(PromptType::ExtractionPrompt),
            weight: p.weight,
            json_key: p.json_key,
            favorite: p.favorite,
        })
        .collect();
    info!("loaded {} prompts", texts.len());
    Ok(Json(texts))
}

async fn get_prompt(
    Path(id): Path<i32>,
    State(db): State<Arc<DatabaseConnection>>,
) -> Result<String, (StatusCode, Json<ErrorResponse>)> {
    info!(id, "fetch prompt");
    let Some(model) = model::prompt::Entity::find_by_id(id)
        .one(&*db)
        .await
        .map_err(|e| {
            error!("db error {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: e.to_string() }),
            )
        })?
    else {
        warn!(id, "prompt not found");
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse { error: "Not found".into() }),
        ));
    };
    Ok(model.text)
}

async fn create_prompt(
    State(db): State<Arc<DatabaseConnection>>,
    Json(input): Json<PromptInput>,
) -> Result<Json<PromptData>, (StatusCode, Json<ErrorResponse>)> {
    info!("creating prompt");
    if input.prompt_type == PromptType::ExtractionPrompt && input.json_key.is_none() {
        return Err((StatusCode::BAD_REQUEST, Json(ErrorResponse { error: "json_key required".into() }))); }
    if input.prompt_type == PromptType::ScoringPrompt && input.weight <= 0.0 {
        return Err((StatusCode::BAD_REQUEST, Json(ErrorResponse { error: "weight must be >0".into() }))); }
    let mut model: model::ActiveModel = Default::default();
    model.text = Set(input.text);
    model.prompt_type = Set(input.prompt_type.to_string());
    model.weight = Set(if input.prompt_type == PromptType::ExtractionPrompt { 1.0 } else { input.weight });
    model.json_key = Set(if input.prompt_type == PromptType::ExtractionPrompt { input.json_key.clone() } else { None });
    model.favorite = Set(input.favorite);
    let res = model.insert(&*db).await.map_err(|e| {
        error!("failed to create prompt: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    for gid in input.group_ids {
        let mut gp: model::GroupPromptActiveModel = Default::default();
        gp.group_id = Set(gid);
        gp.prompt_id = Set(res.id);
        gp.insert(&*db).await.map_err(|e| {
            error!("failed to add prompt to group: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: e.to_string(),
                }),
            )
        })?;
    }
    info!(id = res.id, "created prompt");
    Ok(Json(PromptData {
        id: res.id,
        text: res.text,
        prompt_type: res.prompt_type.parse().unwrap_or(PromptType::ExtractionPrompt),
        weight: res.weight,
        json_key: res.json_key,
        favorite: res.favorite,
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
    let mut active: model::ActiveModel = model.into();
    active.text = Set(input.text);
    active.prompt_type = Set(input.prompt_type.to_string());
    if input.prompt_type == PromptType::ExtractionPrompt && input.json_key.is_none() {
        return Err((StatusCode::BAD_REQUEST, Json(ErrorResponse { error: "json_key required".into() }))); }
    if input.prompt_type == PromptType::ScoringPrompt && input.weight <= 0.0 {
        return Err((StatusCode::BAD_REQUEST, Json(ErrorResponse { error: "weight must be >0".into() }))); }
    active.weight = Set(if input.prompt_type == PromptType::ExtractionPrompt { 1.0 } else { input.weight });
    active.json_key = Set(if input.prompt_type == PromptType::ExtractionPrompt { input.json_key.clone() } else { None });
    active.favorite = Set(input.favorite);
    let res = active.update(&*db).await.map_err(|e| {
        error!("failed to update prompt {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    // update group relations
    GroupPromptEntity::delete_many()
        .filter(model::group_prompt::Column::PromptId.eq(id))
        .exec(&*db)
        .await
        .map_err(|e| {
            error!("failed to clear prompt groups {}: {}", id, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: e.to_string(),
                }),
            )
        })?;
    for gid in input.group_ids {
        let mut gp: model::GroupPromptActiveModel = Default::default();
        gp.group_id = Set(gid);
        gp.prompt_id = Set(id);
        gp.insert(&*db).await.map_err(|e| {
            error!("failed to add prompt to group: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: e.to_string(),
                }),
            )
        })?;
    }
    info!(id = res.id, "updated prompt");
    Ok(Json(PromptData {
        id: res.id,
        text: res.text,
        prompt_type: res.prompt_type.parse().unwrap_or(PromptType::ExtractionPrompt),
        weight: res.weight,
        json_key: res.json_key,
        favorite: res.favorite,
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

async fn list_groups(
    State(db): State<Arc<DatabaseConnection>>,
) -> Result<Json<Vec<GroupData>>, (StatusCode, Json<ErrorResponse>)> {
    info!("listing groups");
    let groups = GroupEntity::find().all(&*db).await.map_err(|e| {
        error!("failed to list groups: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    let mut result = Vec::new();
    for g in groups {
        let members = GroupPromptEntity::find()
            .filter(model::group_prompt::Column::GroupId.eq(g.id))
            .all(&*db)
            .await
            .map_err(|e| {
                error!("failed to list group prompts: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: e.to_string(),
                    }),
                )
            })?;
        result.push(GroupData {
            id: g.id,
            name: g.name,
            favorite: g.favorite,
            prompt_ids: members.into_iter().map(|m| m.prompt_id).collect(),
        });
    }
    Ok(Json(result))
}

async fn create_group(
    State(db): State<Arc<DatabaseConnection>>,
    Json(input): Json<GroupInput>,
) -> Result<Json<GroupData>, (StatusCode, Json<ErrorResponse>)> {
    info!("creating group");
    let mut group: model::GroupActiveModel = Default::default();
    group.name = Set(input.name);
    group.favorite = Set(input.favorite);
    let g = group.insert(&*db).await.map_err(|e| {
        error!("failed to create group: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    for pid in &input.prompt_ids {
        let mut gp: model::GroupPromptActiveModel = Default::default();
        gp.group_id = Set(g.id);
        gp.prompt_id = Set(*pid);
        gp.insert(&*db).await.map_err(|e| {
            error!("failed to add prompt to group: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: e.to_string(),
                }),
            )
        })?;
    }
    Ok(Json(GroupData {
        id: g.id,
        name: g.name,
        favorite: g.favorite,
        prompt_ids: input.prompt_ids,
    }))
}

async fn update_group(
    Path(id): Path<i32>,
    State(db): State<Arc<DatabaseConnection>>,
    Json(input): Json<GroupInput>,
) -> Result<Json<GroupData>, (StatusCode, Json<ErrorResponse>)> {
    info!(id, "updating group");
    let Some(mut group) = GroupEntity::find_by_id(id).one(&*db).await.map_err(|e| {
        error!("failed to find group {}: {}", id, e);
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
    group.name = input.name;
    group.favorite = input.favorite;
    let active: model::GroupActiveModel = group.into();
    let g = active.update(&*db).await.map_err(|e| {
        error!("failed to update group {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;

    GroupPromptEntity::delete_many()
        .filter(model::group_prompt::Column::GroupId.eq(id))
        .exec(&*db)
        .await
        .map_err(|e| {
            error!("failed to clear group prompts {}: {}", id, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: e.to_string(),
                }),
            )
        })?;

    let ids = input.prompt_ids.clone();
    for pid in &ids {
        let mut gp: model::GroupPromptActiveModel = Default::default();
        gp.group_id = Set(id);
        gp.prompt_id = Set(*pid);
        gp.insert(&*db).await.map_err(|e| {
            error!("failed to add prompt to group: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: e.to_string(),
                }),
            )
        })?;
    }

    Ok(Json(GroupData {
        id: g.id,
        name: g.name,
        favorite: g.favorite,
        prompt_ids: ids,
    }))
}

async fn set_group_favorite(
    Path(id): Path<i32>,
    State(db): State<Arc<DatabaseConnection>>,
    Json(input): Json<FavoriteInput>,
) -> Result<Json<GroupData>, (StatusCode, Json<ErrorResponse>)> {
    let Some(mut group) = GroupEntity::find_by_id(id).one(&*db).await.map_err(|e| {
        error!("failed to find group {}: {}", id, e);
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
    group.favorite = input.favorite;
    let active: model::GroupActiveModel = group.into();
    let g = active.update(&*db).await.map_err(|e| {
        error!("failed to update group favorite: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    let members = GroupPromptEntity::find()
        .filter(model::group_prompt::Column::GroupId.eq(g.id))
        .all(&*db)
        .await
        .map_err(|e| {
            error!("failed to list group prompts: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: e.to_string(),
                }),
            )
        })?;
    Ok(Json(GroupData {
        id: g.id,
        name: g.name,
        favorite: g.favorite,
        prompt_ids: members.into_iter().map(|m| m.prompt_id).collect(),
    }))
}

#[derive(Deserialize)]
struct FavoriteInput {
    favorite: bool,
}

async fn set_favorite(
    Path(id): Path<i32>,
    State(db): State<Arc<DatabaseConnection>>,
    Json(input): Json<FavoriteInput>,
) -> Result<Json<PromptData>, (StatusCode, Json<ErrorResponse>)> {
    info!(id, favorite = input.favorite, "setting favorite");
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
    model.favorite = input.favorite;
    let active: model::ActiveModel = model.into();
    let res = active.update(&*db).await.map_err(|e| {
        error!("failed to update favorite {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;
    Ok(Json(PromptData {
        id: res.id,
        text: res.text,
        prompt_type: res.prompt_type.parse().unwrap_or(PromptType::ExtractionPrompt),
        weight: res.weight,
        json_key: res.json_key,
        favorite: res.favorite,
    }))
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
    })?
    else {
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
    })?
    else {
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
    // Logging: Level via RUST_LOG steuern
    fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();
    let settings = Settings::new().unwrap_or_else(|_| Settings {
        database_url:
            "postgres://regress:nITj%22%2B0%28f89F@localhost:5432/regress".into(),
        message_broker_url: String::new(),
        openai_api_key: String::new(),
        class_prompt_id: 0,
    });
    let db: Arc<DatabaseConnection> = Arc::new(Database::connect(&settings.database_url).await?);
    // create table if not exists
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "CREATE TABLE IF NOT EXISTS prompts (id SERIAL PRIMARY KEY, text TEXT NOT NULL, weight DOUBLE PRECISION NOT NULL DEFAULT 1, favorite BOOLEAN NOT NULL DEFAULT FALSE)",
    ))
    .await?;
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "ALTER TABLE prompts ADD COLUMN IF NOT EXISTS prompt_type TEXT DEFAULT 'ExtractionPrompt'",
    ))
    .await?;
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "ALTER TABLE prompts ADD COLUMN IF NOT EXISTS weight DOUBLE PRECISION DEFAULT 1",
    ))
    .await?;
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "ALTER TABLE prompts ADD COLUMN IF NOT EXISTS favorite BOOLEAN NOT NULL DEFAULT FALSE",
    ))
    .await?;
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "ALTER TABLE prompts ADD COLUMN IF NOT EXISTS json_key TEXT",
    ))
    .await?;
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "UPDATE prompts SET favorite = FALSE WHERE favorite IS NULL",
    ))
    .await?;
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "UPDATE prompts SET prompt_type = 'ExtractionPrompt' WHERE prompt_type IS NULL",
    ))
    .await?;
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "ALTER TABLE prompts ALTER COLUMN favorite SET NOT NULL",
    ))
    .await?;
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "UPDATE prompts SET weight = 1 WHERE weight IS NULL",
    ))
    .await?;
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "ALTER TABLE prompts ALTER COLUMN weight SET NOT NULL",
    ))
    .await?;
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "ALTER TABLE prompts ALTER COLUMN prompt_type SET NOT NULL",
    ))
    .await?;

    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "CREATE TABLE IF NOT EXISTS prompt_groups (id SERIAL PRIMARY KEY, name TEXT NOT NULL, favorite BOOLEAN NOT NULL DEFAULT FALSE)",
    ))
    .await?;
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "CREATE TABLE IF NOT EXISTS group_prompts (group_id INTEGER NOT NULL REFERENCES prompt_groups(id) ON DELETE CASCADE, prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE, PRIMARY KEY (group_id, prompt_id))",
    ))
    .await?;

    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "CREATE TABLE IF NOT EXISTS pipelines (id SERIAL PRIMARY KEY, name TEXT NOT NULL, data JSONB NOT NULL)",
    ))
    .await?;

    let app = Router::new()
        .route("/health", get(health))
        .route("/prompts", get(list_prompts).post(create_prompt))
        .route(
            "/prompts/:id",
            get(get_prompt).put(update_prompt).delete(delete_prompt),
        )
        .route("/prompts/:id/favorite", put(set_favorite))
        .route("/prompt-groups", get(list_groups).post(create_group))
        .route("/prompt-groups/:id", put(update_group))
        .route("/prompt-groups/:id/favorite", put(set_group_favorite))
        .route("/pipelines", get(list_pipelines).post(create_pipeline))
        .route("/pipelines/:id", put(update_pipeline).delete(delete_pipeline))
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
    use axum::{Router, extract::Query};
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
                    prompt_type: "ExtractionPrompt".into(),
                    weight: 2.0,
                    json_key: None,
                    favorite: false,
                }]])
                .append_query_results([[model::Model {
                    id: 1,
                    text: "hello".into(),
                    prompt_type: "ExtractionPrompt".into(),
                    weight: 2.0,
                    json_key: None,
                    favorite: false,
                }]])
                .append_exec_results([MockExecResult {
                    last_insert_id: 0,
                    rows_affected: 1,
                }])
                .append_query_results([[model::Model {
                    id: 1,
                    text: "world".into(),
                    prompt_type: "ScoringPrompt".into(),
                    weight: 3.0,
                    json_key: None,
                    favorite: true,
                }]])
                .into_connection(),
        );

        let res = create_prompt(
            State(db.clone()),
            Json(PromptInput {
                text: "hello".into(),
                prompt_type: PromptType::ExtractionPrompt,
                weight: 2.0,
                json_key: None,
                favorite: false,
                group_ids: vec![],
            }),
        )
        .await
        .unwrap();
        assert_eq!(res.0.weight, 2.0);
        assert!(!res.0.favorite);

        let res = update_prompt(
            Path(1),
            State(db.clone()),
            Json(PromptInput {
                text: "world".into(),
                prompt_type: PromptType::ScoringPrompt,
                weight: 3.0,
                json_key: None,
                favorite: true,
                group_ids: vec![],
            }),
        )
        .await
        .unwrap();
        assert_eq!(res.0.weight, 3.0);
        assert!(res.0.favorite);
    }

    #[tokio::test]
    async fn filter_by_type() {
        let db = Arc::new(
            MockDatabase::new(DbBackend::Postgres)
                .append_query_results([[model::Model {
                    id: 1,
                    text: "t".into(),
                    prompt_type: "ExtractionPrompt".into(),
                    weight: 1.0,
                    json_key: None,
                    favorite: false,
                }]])
                .into_connection(),
        );

        let res = list_prompts(State(db.clone()), Query(ListParams { r#type: Some(PromptType::ExtractionPrompt) })).await.unwrap();
        assert_eq!(res.0.len(), 1);
        assert_eq!(res.0[0].prompt_type, PromptType::ExtractionPrompt);
    }

    #[tokio::test]
    async fn set_favorite_route() {
        let db = Arc::new(
            MockDatabase::new(DbBackend::Postgres)
                .append_query_results([[model::Model {
                    id: 1,
                    text: "test".into(),
                    prompt_type: "ExtractionPrompt".into(),
                    weight: 1.0,
                    json_key: None,
                    favorite: false,
                }]])
                .append_exec_results([MockExecResult {
                    last_insert_id: 0,
                    rows_affected: 1,
                }])
                .append_query_results([[model::Model {
                    id: 1,
                    text: "test".into(),
                    prompt_type: "ExtractionPrompt".into(),
                    weight: 1.0,
                    json_key: None,
                    favorite: true,
                }]])
                .into_connection(),
        );

        let res = set_favorite(
            Path(1),
            State(db.clone()),
            Json(FavoriteInput { favorite: true }),
        )
        .await
        .unwrap();
        assert!(res.0.favorite);
    }

    #[tokio::test]
    async fn create_group_route() {
        let db = Arc::new(
            MockDatabase::new(DbBackend::Postgres)
                .append_exec_results([MockExecResult {
                    last_insert_id: 1,
                    rows_affected: 1,
                }])
                .append_exec_results([MockExecResult {
                    last_insert_id: 0,
                    rows_affected: 1,
                }])
                .append_query_results([[model::GroupModel {
                    id: 1,
                    name: "g".into(),
                    favorite: false,
                }]])
                .append_query_results([[model::GroupPromptModel {
                    group_id: 1,
                    prompt_id: 2,
                }]])
                .into_connection(),
        );

        let res = create_group(
            State(db.clone()),
            Json(GroupInput {
                name: "g".into(),
                prompt_ids: vec![2],
                favorite: false,
            }),
        )
        .await
        .unwrap();
        assert_eq!(res.0.name, "g");
        assert_eq!(res.0.prompt_ids, vec![2]);
    }

    #[tokio::test]
    async fn update_group_route() {
        let db = Arc::new(
            MockDatabase::new(DbBackend::Postgres)
                .append_query_results([[model::GroupModel {
                    id: 1,
                    name: "g".into(),
                    favorite: false,
                }]])
                .append_exec_results([MockExecResult {
                    last_insert_id: 0,
                    rows_affected: 1,
                }])
                .append_exec_results([MockExecResult {
                    last_insert_id: 0,
                    rows_affected: 1,
                }])
                .append_query_results([[model::GroupModel {
                    id: 1,
                    name: "new".into(),
                    favorite: true,
                }]])
                .append_query_results([[model::GroupPromptModel {
                    group_id: 1,
                    prompt_id: 3,
                }]])
                .into_connection(),
        );

        let res = update_group(
            Path(1),
            State(db.clone()),
            Json(GroupInput {
                name: "new".into(),
                prompt_ids: vec![3],
                favorite: true,
            }),
        )
        .await
        .unwrap();
        assert_eq!(res.0.name, "new");
        assert_eq!(res.0.prompt_ids, vec![3]);
        assert!(res.0.favorite);
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
