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
use shared::config::Settings;
use shared::dto::PromptType;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

mod model;
use model::{
    group::{ActiveModel as GroupActiveModel, Entity as GroupEntity, Model as GroupModel},
    group_prompt::{
        ActiveModel as GroupPromptActiveModel, Entity as GroupPromptEntity,
        Model as GroupPromptModel,
    },
    pipeline::{
        ActiveModel as PipelineActiveModel, Entity as PipelineEntity, Model as PipelineModel,
    },
    prompt::{
        ActiveModel as PromptActiveModel, Entity as Prompt, Model as PromptModel,
        Column as PromptColumn,
    },
};
use tracing::{error, info, warn};
use tracing_subscriber::{fmt, EnvFilter};

/* ----------------------------- Helpers ----------------------------- */

fn ensure_sslmode_disable(url: &str) -> String {
    if url.contains("sslmode=") {
        url.to_string()
    } else if url.contains('?') {
        format!("{url}&sslmode=disable")
    } else {
        format!("{url}?sslmode=disable")
    }
}

async fn health() -> &'static str {
    info!("health check request");
    "OK"
}

/* ------------------------------ Types ------------------------------ */

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

/* --------------------------- Prompt CRUD --------------------------- */

async fn list_prompts(
    State(db): State<Arc<DatabaseConnection>>,
    Query(params): Query<ListParams>,
) -> Result<Json<Vec<PromptData>>, (StatusCode, Json<ErrorResponse>)> {
    info!("listing prompts");
    let mut query = Prompt::find();
    if let Some(t) = params.r#type {
        query = query.filter(PromptColumn::PromptType.eq(t.to_string()));
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
            prompt_type: p
                .prompt_type
                .parse()
                .unwrap_or(PromptType::ExtractionPrompt),
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
    let Some(model) = Prompt::find_by_id(id).one(&*db).await.map_err(|e| {
        error!("db error {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })? else {
        warn!(id, "prompt not found");
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Not found".into(),
            }),
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
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "json_key required".into(),
            }),
        ));
    }
    if input.prompt_type == PromptType::ScoringPrompt && input.weight <= 0.0 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "weight must be >0".into(),
            }),
        ));
    }

    let mut am: PromptActiveModel = Default::default();
    am.text = Set(input.text);
    am.prompt_type = Set(input.prompt_type.to_string());
    am.weight = Set(if input.prompt_type == PromptType::ExtractionPrompt {
        1.0
    } else {
        input.weight
    });
    am.json_key = Set(if input.prompt_type == PromptType::ExtractionPrompt {
        input.json_key.clone()
    } else {
        None
    });
    am.favorite = Set(input.favorite);

    let res = am.insert(&*db).await.map_err(|e| {
        error!("failed to create prompt: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;

    for gid in input.group_ids {
        let mut gp: GroupPromptActiveModel = Default::default();
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
        prompt_type: res
            .prompt_type
            .parse()
            .unwrap_or(PromptType::ExtractionPrompt),
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
    let Some(model) = Prompt::find_by_id(id).one(&*db).await.map_err(|e| {
        error!("failed to find prompt {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })? else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Not found".into(),
            }),
        ));
    };

    if input.prompt_type == PromptType::ExtractionPrompt && input.json_key.is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "json_key required".into(),
            }),
        ));
    }
    if input.prompt_type == PromptType::ScoringPrompt && input.weight <= 0.0 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "weight must be >0".into(),
            }),
        ));
    }

    let mut am: PromptActiveModel = model.into();
    am.text = Set(input.text);
    am.prompt_type = Set(input.prompt_type.to_string());
    am.weight = Set(if input.prompt_type == PromptType::ExtractionPrompt {
        1.0
    } else {
        input.weight
    });
    am.json_key = Set(if input.prompt_type == PromptType::ExtractionPrompt {
        input.json_key.clone()
    } else {
        None
    });
    am.favorite = Set(input.favorite);

    let res = am.update(&*db).await.map_err(|e| {
        error!("failed to update prompt {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;

    // Gruppenbeziehungen neu setzen
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
        let mut gp: GroupPromptActiveModel = Default::default();
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

    info!(id = res.id, "updated prompt");
    Ok(Json(PromptData {
        id: res.id,
        text: res.text,
        prompt_type: res
            .prompt_type
            .parse()
            .unwrap_or(PromptType::ExtractionPrompt),
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
    })? else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Not found".into(),
            }),
        ));
    };
    let am: PromptActiveModel = model.into();
    am.delete(&*db).await.map_err(|e| {
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

/* ---------------------------- Group CRUD --------------------------- */

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
    let mut am: GroupActiveModel = Default::default();
    am.name = Set(input.name);
    am.favorite = Set(input.favorite);
    let g = am.insert(&*db).await.map_err(|e| {
        error!("failed to create group: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })?;

    for pid in &input.prompt_ids {
        let mut gp: GroupPromptActiveModel = Default::default();
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
    let Some(group) = GroupEntity::find_by_id(id).one(&*db).await.map_err(|e| {
        error!("failed to find group {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })? else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Not found".into(),
            }),
        ));
    };

    let mut am: GroupActiveModel = group.into();
    am.name = Set(input.name);
    am.favorite = Set(input.favorite);
    let g = am.update(&*db).await.map_err(|e| {
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
        let mut gp: GroupPromptActiveModel = Default::default();
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

#[derive(Deserialize)]
struct FavoriteInput {
    favorite: bool,
}

async fn set_group_favorite(
    Path(id): Path<i32>,
    State(db): State<Arc<DatabaseConnection>>,
    Json(input): Json<FavoriteInput>,
) -> Result<Json<GroupData>, (StatusCode, Json<ErrorResponse>)> {
    let Some(group) = GroupEntity::find_by_id(id).one(&*db).await.map_err(|e| {
        error!("failed to find group {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
            }),
        )
    })? else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Not found".into(),
            }),
        ));
    };

    let mut am: GroupActiveModel = group.into();
    am.favorite = Set(input.favorite);
    let g = am.update(&*db).await.map_err(|e| {
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

/* --------------------------- Pipeline CRUD ------------------------- */

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
    let mut am: PipelineActiveModel = Default::default();
    am.name = Set(input.name);
    am.data = Set(input.data);
    let res = am.insert(&*db).await.map_err(|e| {
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

    let mut am: PipelineActiveModel = model.into();
    am.name = Set(input.name);
    am.data = Set(input.data);
    let res = am.update(&*db).await.map_err(|e| {
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

    let am: PipelineActiveModel = model.into();
    am.delete(&*db).await.map_err(|e| {
        error!("failed to delete pipeline {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e.to_string() }),
        )
    })?;
    Ok(())
}

/* -------------------------------- Main ----------------------------- */

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Logging: Level via RUST_LOG steuern
    fmt().with_env_filter(EnvFilter::from_default_env()).init();

    // Settings laden
    let settings = Settings::new().unwrap_or_else(|_| Settings {
        // Default nur als Fallback; in Swarm/Portainer bitte DATABASE_URL setzen!
        database_url: "postgres://regress_app:nITj%22%2B0%28f89F@haproxy:5432/regress".into(),
        message_broker_url: String::new(),
        openai_api_key: String::new(),
        class_prompt_id: 0,
    });

    // SSL aus (falls nicht ohnehin am Ende vorhanden)
    let db_url = ensure_sslmode_disable(&settings.database_url);
    if db_url != settings.database_url {
        warn!("DATABASE_URL had no sslmode – using '{}'", db_url);
    }

    // DB‑Connect
    let db: Arc<DatabaseConnection> = Arc::new(Database::connect(&db_url).await?);

    // Schema robust sicherstellen
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "CREATE TABLE IF NOT EXISTS prompts (
            id SERIAL PRIMARY KEY,
            text TEXT NOT NULL,
            prompt_type TEXT NOT NULL DEFAULT 'ExtractionPrompt',
            weight DOUBLE PRECISION NOT NULL DEFAULT 1,
            json_key TEXT,
            favorite BOOLEAN NOT NULL DEFAULT FALSE
        )",
    ))
        .await?;

    // Nachziehen historischer Spalten/Defaults (idempotent)
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
        "ALTER TABLE prompts ADD COLUMN IF NOT EXISTS favorite BOOLEAN DEFAULT FALSE",
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
        "CREATE TABLE IF NOT EXISTS prompt_groups (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            favorite BOOLEAN NOT NULL DEFAULT FALSE
        )",
    ))
        .await?;
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "CREATE TABLE IF NOT EXISTS group_prompts (
            group_id INTEGER NOT NULL REFERENCES prompt_groups(id) ON DELETE CASCADE,
            prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
            PRIMARY KEY (group_id, prompt_id)
        )",
    ))
        .await?;

    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "CREATE TABLE IF NOT EXISTS pipelines (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            data JSONB NOT NULL
        )",
    ))
        .await?;

    // Router
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

    info!("starting prompt-manager on 0.0.0.0:8082");
    axum::Server::bind(&"0.0.0.0:8082".parse::<std::net::SocketAddr>()?)
        .serve(app.into_make_service())
        .await?;
    Ok(())
}

/* -------------------------------- Tests ---------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::Query, Router};
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
        // Prompt CRUD happy path über Mock DB
        let db = Arc::new(
            MockDatabase::new(DbBackend::Postgres)
                .append_exec_results([MockExecResult {
                    last_insert_id: 1,
                    rows_affected: 1,
                }]) // insert prompt
                .append_query_results([[PromptModel {
                    id: 1,
                    text: "hello".into(),
                    prompt_type: "ExtractionPrompt".into(),
                    weight: 2.0,
                    json_key: None,
                    favorite: false,
                }]]) // get after insert
                .append_query_results([[PromptModel {
                    id: 1,
                    text: "hello".into(),
                    prompt_type: "ExtractionPrompt".into(),
                    weight: 2.0,
                    json_key: None,
                    favorite: false,
                }]]) // find_by_id for update
                .append_exec_results([MockExecResult {
                    last_insert_id: 0,
                    rows_affected: 1,
                }]) // update
                .append_query_results([[PromptModel {
                    id: 1,
                    text: "world".into(),
                    prompt_type: "ScoringPrompt".into(),
                    weight: 3.0,
                    json_key: None,
                    favorite: true,
                }]]) // get after update
                .into_connection(),
        );

        let res = create_prompt(
            State(db.clone()),
            Json(super::PromptInput {
                text: "hello".into(),
                prompt_type: PromptType::ExtractionPrompt,
                weight: 2.0,
                json_key: Some("k".into()),
                favorite: false,
                group_ids: vec![],
            }),
        )
            .await
            .unwrap();
        assert_eq!(res.0.weight, 1.0); // ExtractionPrompt erzwingt weight=1.0
        assert!(!res.0.favorite);

        let res = update_prompt(
            Path(1),
            State(db.clone()),
            Json(super::PromptInput {
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
                .append_query_results([[PromptModel {
                    id: 1,
                    text: "t".into(),
                    prompt_type: "ExtractionPrompt".into(),
                    weight: 1.0,
                    json_key: None,
                    favorite: false,
                }]])
                .into_connection(),
        );

        let res = list_prompts(
            State(db.clone()),
            Query(super::ListParams {
                r#type: Some(PromptType::ExtractionPrompt),
            }),
        )
            .await
            .unwrap();
        assert_eq!(res.0.len(), 1);
        assert_eq!(res.0[0].prompt_type, PromptType::ExtractionPrompt);
    }

    #[tokio::test]
    async fn set_favorite_route() {
        let db = Arc::new(
            MockDatabase::new(DbBackend::Postgres)
                .append_query_results([[PromptModel {
                    id: 1,
                    text: "test".into(),
                    prompt_type: "ExtractionPrompt".into(),
                    weight: 1.0,
                    json_key: None,
                    favorite: false,
                }]]) // find_by_id
                .append_exec_results([MockExecResult {
                    last_insert_id: 0,
                    rows_affected: 1,
                }]) // update
                .append_query_results([[PromptModel {
                    id: 1,
                    text: "test".into(),
                    prompt_type: "ExtractionPrompt".into(),
                    weight: 1.0,
                    json_key: None,
                    favorite: true,
                }]]) // get after update
                .into_connection(),
        );

        let res = super::set_favorite(
            Path(1),
            State(db.clone()),
            Json(super::FavoriteInput { favorite: true }),
        )
            .await
            .unwrap();
        assert!(res.0.favorite);
    }

    #[tokio::test]
    async fn create_update_pipeline_route() {
        let db = Arc::new(
            MockDatabase::new(DbBackend::Postgres)
                .append_exec_results([MockExecResult {
                    last_insert_id: 1,
                    rows_affected: 1,
                }]) // insert pipeline
                .append_query_results([[PipelineModel {
                    id: 1,
                    name: "p".into(),
                    data: serde_json::json!({"a":1}),
                }]]) // get after insert
                .append_query_results([[PipelineModel {
                    id: 1,
                    name: "p".into(),
                    data: serde_json::json!({"a":1}),
                }]]) // find_by_id for update
                .append_exec_results([MockExecResult {
                    last_insert_id: 0,
                    rows_affected: 1,
                }]) // update
                .append_query_results([[PipelineModel {
                    id: 1,
                    name: "p2".into(),
                    data: serde_json::json!({"b":2}),
                }]]) // get after update
                .into_connection(),
        );

        let res = create_pipeline(
            State(db.clone()),
            Json(super::PipelineInput {
                name: "p".into(),
                data: serde_json::json!({"a":1}),
            }),
        )
            .await
            .unwrap();
        assert_eq!(res.0.name, "p");

        let res = update_pipeline(
            Path(1),
            State(db.clone()),
            Json(super::PipelineInput {
                name: "p2".into(),
                data: serde_json::json!({"b":2}),
            }),
        )
            .await
            .unwrap();
        assert_eq!(res.0.name, "p2");
    }
}
