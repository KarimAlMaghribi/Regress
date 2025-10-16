//! REST API for managing prompts, groups and pipeline associations.

use axum::{
    extract::{Path, State, Query},
    http::StatusCode,
    routing::{get, put},
    Json, Router,
};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, Database, DatabaseConnection, EntityTrait,
    QueryFilter, Set, Statement,
};
use sea_orm::prelude::Decimal;
use serde::{Deserialize, Serialize};
use shared::config::Settings;
use shared::dto::PromptType;
use std::str::FromStr;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tracing::{error, info};
use tracing_subscriber::{fmt, EnvFilter};
use uuid::Uuid;

mod model;
use model::{
    group::{Entity as GroupEntity, ActiveModel as GroupActiveModel},
    group_prompt::{Entity as GroupPromptEntity, ActiveModel as GroupPromptActiveModel},
    pipeline::{Entity as PipelineEntity, ActiveModel as PipelineActiveModel},
    prompt::{Entity as Prompt, ActiveModel as PromptActiveModel},
};

/// Ensures the database connection string disables SSL for local setups.
fn ensure_sslmode_disable(url: &str) -> String {
    if url.to_ascii_lowercase().contains("sslmode=") {
        return url.to_string();
    }

    let disable_for_local = url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_ascii_lowercase()))
        .map(|host| matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1"))
        .unwrap_or(false);

    if !disable_for_local {
        return url.to_string();
    }

    if url.contains('?') {
        format!("{url}&sslmode=disable")
    } else {
        format!("{url}?sslmode=disable")
    }
}

/// Simple liveness endpoint for orchestration.
async fn health() -> &'static str { "OK" }

/* ---------------- DTOs ---------------- */

#[derive(Serialize)]
/// API representation of a prompt including metadata.
struct PromptData {
    id: i32,
    text: String,
    #[serde(rename = "type")]
    prompt_type: PromptType,
    // Nur Scoring/Decision → Some(...), sonst None
    weight: Option<f64>,
    json_key: Option<String>,
    favorite: bool,
}

#[derive(Deserialize)]
/// Payload used to create or update prompts.
struct PromptInput {
    text: String,
    // optional: bei Scoring/Decision -> default 1.0, sonst ignoriert
    weight: Option<f64>,
    #[serde(default = "default_prompt_type", rename = "type")]
    prompt_type: PromptType,
    json_key: Option<String>,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    group_ids: Vec<i32>,
}

#[derive(Serialize)]
/// API representation of a prompt group with associated prompts.
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
    id: Uuid,
    name: String,
    data: serde_json::Value, // API bleibt "data"
}

#[derive(Deserialize)]
struct PipelineInput {
    name: String,
    data: serde_json::Value,
}

#[derive(Serialize, Debug)]
struct ErrorResponse { error: String }

fn default_prompt_type() -> PromptType { PromptType::ExtractionPrompt }

#[derive(Deserialize)]
struct ListParams {
    #[serde(rename = "type")]
    r#type: Option<PromptType>,
}

fn is_weighted(t: &PromptType) -> bool {
    matches!(t, PromptType::ScoringPrompt | PromptType::DecisionPrompt)
}

// Hilfsfunktionen: f64 <-> Decimal (NUMERIC)
fn f64_to_decimal_opt(w: Option<f64>) -> Option<Decimal> {
    w.and_then(|x| Decimal::from_str(&format!("{:.3}", x)).ok())
}
fn decimal_to_f64_opt(d: Option<Decimal>) -> Option<f64> {
    d.and_then(|v| v.to_string().parse::<f64>().ok())
}

/* ---------------- Prompts ---------------- */

async fn list_prompts(
    State(db): State<Arc<DatabaseConnection>>,
    Query(params): Query<ListParams>,
) -> Result<Json<Vec<PromptData>>, (StatusCode, Json<ErrorResponse>)> {
    let mut query = Prompt::find();
    if let Some(t) = params.r#type {
        query = query.filter(model::prompt::Column::PromptType.eq(t.to_string()));
    }
    let items = query.all(&*db).await.map_err(int_err)?;
    let texts: Vec<PromptData> = items
        .into_iter()
        .map(|p| PromptData {
            id: p.id,
            text: p.text,
            prompt_type: p.prompt_type.parse().unwrap_or(PromptType::ExtractionPrompt),
            weight: decimal_to_f64_opt(p.weight),
            json_key: p.json_key,
            favorite: p.favorite,
        })
        .collect();
    Ok(Json(texts))
}

async fn get_prompt(
    Path(id): Path<i32>,
    State(db): State<Arc<DatabaseConnection>>,
) -> Result<String, (StatusCode, Json<ErrorResponse>)> {
    let Some(model) = Prompt::find_by_id(id).one(&*db).await.map_err(int_err)? else {
        return Err(not_found());
    };
    Ok(model.text)
}

async fn create_prompt(
    State(db): State<Arc<DatabaseConnection>>,
    Json(input): Json<PromptInput>,
) -> Result<Json<PromptData>, (StatusCode, Json<ErrorResponse>)> {
    // Validierung
    if input.prompt_type == PromptType::ExtractionPrompt && input.json_key.is_none() {
        return Err(bad_request("json_key required"));
    }
    if is_weighted(&input.prompt_type) && input.weight.unwrap_or(1.0) <= 0.0 {
        return Err(bad_request("weight must be > 0"));
    }

    let weight_dec = if is_weighted(&input.prompt_type) {
        f64_to_decimal_opt(Some(input.weight.unwrap_or(1.0)))
    } else {
        None
    };
    let json_key = if input.prompt_type == PromptType::ExtractionPrompt {
        input.json_key.clone()
    } else {
        None
    };

    let mut model: PromptActiveModel = Default::default();
    model.text        = Set(input.text);
    model.prompt_type = Set(input.prompt_type.to_string());
    model.weight      = Set(weight_dec);
    model.json_key    = Set(json_key);
    model.favorite    = Set(input.favorite);

    let res = model.insert(&*db).await.map_err(int_err)?;

    // Gruppen-Beziehungen anlegen
    for gid in input.group_ids {
        let mut gp: GroupPromptActiveModel = Default::default();
        gp.group_id = Set(gid);
        gp.prompt_id = Set(res.id);
        gp.insert(&*db).await.map_err(int_err)?;
    }

    Ok(Json(PromptData {
        id: res.id,
        text: res.text,
        prompt_type: res.prompt_type.parse().unwrap_or(PromptType::ExtractionPrompt),
        weight: decimal_to_f64_opt(res.weight),
        json_key: res.json_key,
        favorite: res.favorite,
    }))
}

async fn update_prompt(
    Path(id): Path<i32>,
    State(db): State<Arc<DatabaseConnection>>,
    Json(input): Json<PromptInput>,
) -> Result<Json<PromptData>, (StatusCode, Json<ErrorResponse>)> {
    let Some(model) = Prompt::find_by_id(id).one(&*db).await.map_err(int_err)? else {
        return Err(not_found());
    };

    if input.prompt_type == PromptType::ExtractionPrompt && input.json_key.is_none() {
        return Err(bad_request("json_key required"));
    }
    if is_weighted(&input.prompt_type) && input.weight.unwrap_or(1.0) <= 0.0 {
        return Err(bad_request("weight must be > 0"));
    }

    let weight_dec = if is_weighted(&input.prompt_type) {
        f64_to_decimal_opt(Some(input.weight.unwrap_or(1.0)))
    } else {
        None
    };
    let json_key = if input.prompt_type == PromptType::ExtractionPrompt {
        input.json_key.clone()
    } else {
        None
    };

    let mut active: PromptActiveModel = model.into();
    active.text        = Set(input.text);
    active.prompt_type = Set(input.prompt_type.to_string());
    active.weight      = Set(weight_dec);
    active.json_key    = Set(json_key);
    active.favorite    = Set(input.favorite);

    let res = active.update(&*db).await.map_err(int_err)?;

    // Gruppenbeziehungen ersetzen
    GroupPromptEntity::delete_many()
        .filter(model::group_prompt::Column::PromptId.eq(id))
        .exec(&*db).await.map_err(int_err)?;
    for gid in input.group_ids {
        let mut gp: GroupPromptActiveModel = Default::default();
        gp.group_id = Set(gid);
        gp.prompt_id = Set(id);
        gp.insert(&*db).await.map_err(int_err)?;
    }

    Ok(Json(PromptData {
        id: res.id,
        text: res.text,
        prompt_type: res.prompt_type.parse().unwrap_or(PromptType::ExtractionPrompt),
        weight: decimal_to_f64_opt(res.weight),
        json_key: res.json_key,
        favorite: res.favorite,
    }))
}

async fn delete_prompt(
    Path(id): Path<i32>,
    State(db): State<Arc<DatabaseConnection>>,
) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
    let Some(model) = Prompt::find_by_id(id).one(&*db).await.map_err(int_err)? else {
        return Err(not_found());
    };
    let active: PromptActiveModel = model.into();
    active.delete(&*db).await.map_err(int_err)?;
    Ok(())
}

#[derive(Deserialize)]
struct FavoriteInput { favorite: bool }

async fn set_favorite(
    Path(id): Path<i32>,
    State(db): State<Arc<DatabaseConnection>>,
    Json(input): Json<FavoriteInput>,
) -> Result<Json<PromptData>, (StatusCode, Json<ErrorResponse>)> {
    let Some(model) = Prompt::find_by_id(id).one(&*db).await.map_err(int_err)? else {
        return Err(not_found());
    };
    let mut active: PromptActiveModel = model.into();
    active.favorite = Set(input.favorite);
    let res = active.update(&*db).await.map_err(int_err)?;
    Ok(Json(PromptData {
        id: res.id,
        text: res.text,
        prompt_type: res.prompt_type.parse().unwrap_or(PromptType::ExtractionPrompt),
        weight: decimal_to_f64_opt(res.weight),
        json_key: res.json_key,
        favorite: res.favorite,
    }))
}

/* ---------------- Groups ---------------- */

async fn list_groups(
    State(db): State<Arc<DatabaseConnection>>,
) -> Result<Json<Vec<GroupData>>, (StatusCode, Json<ErrorResponse>)> {
    let groups = GroupEntity::find().all(&*db).await.map_err(int_err)?;
    let mut result = Vec::new();
    for g in groups {
        let members = GroupPromptEntity::find()
            .filter(model::group_prompt::Column::GroupId.eq(g.id))
            .all(&*db).await.map_err(int_err)?;
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
    let mut group: GroupActiveModel = Default::default();
    group.name = Set(input.name);
    group.favorite = Set(input.favorite);
    let g = group.insert(&*db).await.map_err(int_err)?;
    for pid in &input.prompt_ids {
        let mut gp: GroupPromptActiveModel = Default::default();
        gp.group_id = Set(g.id);
        gp.prompt_id = Set(*pid);
        gp.insert(&*db).await.map_err(int_err)?;
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
    let Some(mut group) = GroupEntity::find_by_id(id).one(&*db).await.map_err(int_err)? else {
        return Err(not_found());
    };
    group.name = input.name;
    group.favorite = input.favorite;
    let active: GroupActiveModel = group.into();
    let g = active.update(&*db).await.map_err(int_err)?;

    GroupPromptEntity::delete_many()
        .filter(model::group_prompt::Column::GroupId.eq(id))
        .exec(&*db).await.map_err(int_err)?;

    let ids = input.prompt_ids.clone();
    for pid in &ids {
        let mut gp: GroupPromptActiveModel = Default::default();
        gp.group_id = Set(id);
        gp.prompt_id = Set(*pid);
        gp.insert(&*db).await.map_err(int_err)?;
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
    let Some(mut group) = GroupEntity::find_by_id(id).one(&*db).await.map_err(int_err)? else {
        return Err(not_found());
    };
    group.favorite = input.favorite;
    let active: GroupActiveModel = group.into();
    let g = active.update(&*db).await.map_err(int_err)?;
    let members = GroupPromptEntity::find()
        .filter(model::group_prompt::Column::GroupId.eq(g.id))
        .all(&*db).await.map_err(int_err)?;
    Ok(Json(GroupData {
        id: g.id,
        name: g.name,
        favorite: g.favorite,
        prompt_ids: members.into_iter().map(|m| m.prompt_id).collect(),
    }))
}

/* ---------------- Pipelines ---------------- */

async fn list_pipelines(
    State(db): State<Arc<DatabaseConnection>>,
) -> Result<Json<Vec<PipelineData>>, (StatusCode, Json<ErrorResponse>)> {
    let items = PipelineEntity::find().all(&*db).await.map_err(int_err)?;
    Ok(Json(items.into_iter().map(|p| PipelineData {
        id: p.id,
        name: p.name,
        data: p.config_json, // wichtig: DB-Feld heißt config_json
    }).collect()))
}

async fn create_pipeline(
    State(db): State<Arc<DatabaseConnection>>,
    Json(input): Json<PipelineInput>,
) -> Result<Json<PipelineData>, (StatusCode, Json<ErrorResponse>)> {
    let mut model: PipelineActiveModel = Default::default();
    model.name = Set(input.name);
    model.config_json = Set(input.data);
    let res = model.insert(&*db).await.map_err(int_err)?;
    Ok(Json(PipelineData { id: res.id, name: res.name, data: res.config_json }))
}

async fn update_pipeline(
    Path(id): Path<Uuid>,
    State(db): State<Arc<DatabaseConnection>>,
    Json(input): Json<PipelineInput>,
) -> Result<Json<PipelineData>, (StatusCode, Json<ErrorResponse>)> {
    let Some(mut model) = PipelineEntity::find_by_id(id).one(&*db).await.map_err(int_err)? else {
        return Err(not_found());
    };
    model.name = input.name;
    model.config_json = input.data;
    let active: PipelineActiveModel = model.into();
    let res = active.update(&*db).await.map_err(int_err)?;
    Ok(Json(PipelineData { id: res.id, name: res.name, data: res.config_json }))
}

async fn delete_pipeline(
    Path(id): Path<Uuid>,
    State(db): State<Arc<DatabaseConnection>>,
) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
    let Some(model) = PipelineEntity::find_by_id(id).one(&*db).await.map_err(int_err)? else {
        return Err(not_found());
    };
    let active: PipelineActiveModel = model.into();
    active.delete(&*db).await.map_err(int_err)?;
    Ok(())
}

/* ---------------- Fehler-Helfer ---------------- */

fn int_err<E: std::fmt::Display>(e: E) -> (StatusCode, Json<ErrorResponse>) {
    error!("db error: {}", e);
    (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: e.to_string() }))
}
fn bad_request(msg: &str) -> (StatusCode, Json<ErrorResponse>) {
    (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: msg.into() }))
}
fn not_found() -> (StatusCode, Json<ErrorResponse>) {
    (StatusCode::NOT_FOUND, Json(ErrorResponse { error: "Not found".into() }))
}

/* ---------------- Bootstrap: Prompts-Schema sicherstellen ---------------- */

async fn ensure_prompt_schema(db: &DatabaseConnection) -> Result<(), sea_orm::DbErr> {
    let be = db.get_database_backend();

    // prompts (NUMERIC weight; Constraint greift nur bei Neuanlage)
    db.execute(Statement::from_string(be, r#"
        CREATE TABLE IF NOT EXISTS prompts (
          id           SERIAL PRIMARY KEY,
          text         TEXT NOT NULL,
          prompt_type  TEXT NOT NULL CHECK (prompt_type IN
                           ('ExtractionPrompt','ScoringPrompt','DecisionPrompt','FinalPrompt','MetaPrompt')),
          weight       NUMERIC(6,3),
          json_key     TEXT,
          favorite     BOOLEAN NOT NULL DEFAULT FALSE,
          CONSTRAINT weight_only_for_weighted
            CHECK (
              (prompt_type IN ('ScoringPrompt','DecisionPrompt') AND weight IS NOT NULL)
              OR
              (prompt_type NOT IN ('ScoringPrompt','DecisionPrompt') AND weight IS NULL)
            )
        )
    "#.to_string())).await?;

    // prompt_groups
    db.execute(Statement::from_string(be, r#"
        CREATE TABLE IF NOT EXISTS prompt_groups (
          id        SERIAL PRIMARY KEY,
          name      TEXT NOT NULL UNIQUE,
          favorite  BOOLEAN NOT NULL DEFAULT FALSE
        )
    "#.to_string())).await?;

    // group_prompts
    db.execute(Statement::from_string(be, r#"
        CREATE TABLE IF NOT EXISTS group_prompts (
          group_id   INTEGER NOT NULL REFERENCES prompt_groups(id) ON DELETE CASCADE,
          prompt_id  INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
          PRIMARY KEY (group_id, prompt_id)
        )
    "#.to_string())).await?;

    Ok(())
}

/* ---------------- main ---------------- */

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Logging via RUST_LOG
    fmt().with_env_filter(EnvFilter::from_default_env()).init();

    // DB-URL ohne TLS
    let mut settings = Settings::new().unwrap_or_else(|_| Settings {
        database_url: "postgres://regress:password@localhost:5432/regress".into(),
        message_broker_url: String::new(),
        openai_api_key: String::new(),
        class_prompt_id: 0,
    });
    settings.database_url = ensure_sslmode_disable(&settings.database_url);

    let db: Arc<DatabaseConnection> = Arc::new(Database::connect(&settings.database_url).await?);

    // idempotent: Kernobjekte für Prompt-Manager sicherstellen
    ensure_prompt_schema(&db).await?;

    let app = Router::new()
        .route("/health", get(health))
        .route("/prompts", get(list_prompts).post(create_prompt))
        .route("/prompts/:id", get(get_prompt).put(update_prompt).delete(delete_prompt))
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
