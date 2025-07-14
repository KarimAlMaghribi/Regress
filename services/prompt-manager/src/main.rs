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
use model::{Entity as Prompt, GroupModel, GroupPromptModel};
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
    favorite: bool,
}

#[derive(Deserialize)]
struct PromptInput {
    text: String,
    #[serde(default = "default_weight")]
    weight: f64,
    #[serde(default)]
    favorite: bool,
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
            favorite: p.favorite,
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
    info!(id = res.id, "created prompt");
    Ok(Json(PromptData {
        id: res.id,
        text: res.text,
        weight: res.weight,
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
    model.text = input.text;
    model.weight = input.weight;
    model.favorite = input.favorite;
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
    let groups = GroupModel::find().all(&*db).await.map_err(|e| {
        error!("failed to list groups: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e.to_string() }),
        )
    })?;
    let mut result = Vec::new();
    for g in groups {
        let members = GroupPromptModel::find()
            .filter(model::group_prompt_model::Column::GroupId.eq(g.id))
            .all(&*db)
            .await
            .map_err(|e| {
                error!("failed to list group prompts: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse { error: e.to_string() }),
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
            Json(ErrorResponse { error: e.to_string() }),
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
                Json(ErrorResponse { error: e.to_string() }),
            )
        })?;
    }
    Ok(Json(GroupData { id: g.id, name: g.name, favorite: g.favorite, prompt_ids: input.prompt_ids }))
}

async fn set_group_favorite(
    Path(id): Path<i32>,
    State(db): State<Arc<DatabaseConnection>>,
    Json(input): Json<FavoriteInput>,
) -> Result<Json<GroupData>, (StatusCode, Json<ErrorResponse>)> {
    let Some(mut group) = GroupModel::find_by_id(id).one(&*db).await.map_err(|e| {
        error!("failed to find group {}: {}", id, e);
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
    group.favorite = input.favorite;
    let active: model::GroupActiveModel = group.into();
    let g = active.update(&*db).await.map_err(|e| {
        error!("failed to update group favorite: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e.to_string() }),
        )
    })?;
    let members = GroupPromptModel::find()
        .filter(model::group_prompt_model::Column::GroupId.eq(g.id))
        .all(&*db)
        .await
        .map_err(|e| {
            error!("failed to list group prompts: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse { error: e.to_string() }),
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
            Json(ErrorResponse { error: e.to_string() }),
        )
    })?
    else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse { error: "Not found".into() }),
        ));
    };
    model.favorite = input.favorite;
    let active: model::ActiveModel = model.into();
    let res = active.update(&*db).await.map_err(|e| {
        error!("failed to update favorite {}: {}", id, e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: e.to_string() }),
        )
    })?;
    Ok(Json(PromptData {
        id: res.id,
        text: res.text,
        weight: res.weight,
        favorite: res.favorite,
    }))
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
        "CREATE TABLE IF NOT EXISTS prompts (id SERIAL PRIMARY KEY, text TEXT NOT NULL, weight DOUBLE PRECISION NOT NULL DEFAULT 1, favorite BOOLEAN NOT NULL DEFAULT FALSE)",
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
        "UPDATE prompts SET favorite = FALSE WHERE favorite IS NULL",
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
        "CREATE TABLE IF NOT EXISTS prompt_groups (id SERIAL PRIMARY KEY, name TEXT NOT NULL, favorite BOOLEAN NOT NULL DEFAULT FALSE)",
    ))
    .await?;
    db.execute(sea_orm::Statement::from_string(
        db.get_database_backend(),
        "CREATE TABLE IF NOT EXISTS group_prompts (group_id INTEGER NOT NULL REFERENCES prompt_groups(id) ON DELETE CASCADE, prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE, PRIMARY KEY (group_id, prompt_id))",
    ))
    .await?;

    let app = Router::new()
        .route("/health", get(health))
        .route("/prompts", get(list_prompts).post(create_prompt))
        .route("/prompts/:id", put(update_prompt).delete(delete_prompt))
        .route("/prompts/:id/favorite", put(set_favorite))
        .route("/prompt-groups", get(list_groups).post(create_group))
        .route("/prompt-groups/:id/favorite", put(set_group_favorite))
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
                    favorite: false,
                }]])
                .append_query_results([[model::Model {
                    id: 1,
                    text: "hello".into(),
                    weight: 2.0,
                    favorite: false,
                }]])
                .append_exec_results([MockExecResult {
                    last_insert_id: 0,
                    rows_affected: 1,
                }])
                .append_query_results([[model::Model {
                    id: 1,
                    text: "world".into(),
                    weight: 3.0,
                    favorite: true,
                }]])
                .into_connection(),
        );

        let res = create_prompt(
            State(db.clone()),
            Json(PromptInput {
                text: "hello".into(),
                weight: 2.0,
                favorite: false,
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
                weight: 3.0,
                favorite: true,
            }),
        )
        .await
        .unwrap();
        assert_eq!(res.0.weight, 3.0);
        assert!(res.0.favorite);
    }

    #[tokio::test]
    async fn set_favorite_route() {
        let db = Arc::new(
            MockDatabase::new(DbBackend::Postgres)
                .append_query_results([[model::Model {
                    id: 1,
                    text: "test".into(),
                    weight: 1.0,
                    favorite: false,
                }]])
                .append_exec_results([MockExecResult { last_insert_id: 0, rows_affected: 1 }])
                .append_query_results([[model::Model {
                    id: 1,
                    text: "test".into(),
                    weight: 1.0,
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
                .append_exec_results([MockExecResult { last_insert_id: 1, rows_affected: 1 }])
                .append_exec_results([MockExecResult { last_insert_id: 0, rows_affected: 1 }])
                .append_query_results([[model::GroupModel { id: 1, name: "g".into(), favorite: false }]])
                .append_query_results([[model::GroupPromptModel { group_id: 1, prompt_id: 2 }]])
                .into_connection(),
        );

        let res = create_group(
            State(db.clone()),
            Json(GroupInput { name: "g".into(), prompt_ids: vec![2], favorite: false }),
        )
        .await
        .unwrap();
        assert_eq!(res.0.name, "g");
        assert_eq!(res.0.prompt_ids, vec![2]);
    }
}
