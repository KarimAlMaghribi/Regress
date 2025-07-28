use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use actix_web::web::Json;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use shared::dto::{PipelineConfig, PipelineStep};
use uuid::Uuid;
use tracing::{info, error};
use std::collections::HashMap;

#[derive(Clone)]
struct AppState { pool: PgPool }

#[derive(Serialize)]
struct PipelineInfo {
    id: Uuid,
    name: String,
    steps: Vec<PipelineStep>,
}

async fn fetch_config(pool: &PgPool, id: Uuid) -> Result<PipelineConfig, HttpResponse> {
    let row = sqlx::query("SELECT config_json FROM pipelines WHERE id=$1")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(|_| HttpResponse::NotFound().finish())?;
    let value: serde_json::Value = row.try_get("config_json").unwrap();
    serde_json::from_value(value).map_err(|_| HttpResponse::InternalServerError().finish())
}

async fn store_config(pool: &PgPool, id: Uuid, cfg: &PipelineConfig) -> Result<(), HttpResponse> {
    let json = serde_json::to_value(cfg).unwrap();
    let res = sqlx::query("UPDATE pipelines SET name=$2, config_json=$3, updated_at=now() WHERE id=$1")
        .bind(id)
        .bind(&cfg.name)
        .bind(json)
        .execute(pool)
        .await
        .map_err(|_| HttpResponse::InternalServerError().finish())?;
    if res.rows_affected() == 1 { Ok(()) } else { Err(HttpResponse::NotFound().finish()) }
}

async fn list_pipelines(data: web::Data<AppState>) -> impl Responder {
    match sqlx::query("SELECT id, name, config_json FROM pipelines")
        .fetch_all(&data.pool)
        .await
    {
        Ok(rows) => {
            let res: Vec<PipelineInfo> = rows
                .into_iter()
                .filter_map(|r| {
                    let cfg: PipelineConfig = serde_json::from_value(r.try_get::<serde_json::Value, _>("config_json").ok()?).ok()?;
                    let id: Uuid = r.try_get("id").ok()?;
                    Some(PipelineInfo { id, name: cfg.name, steps: cfg.steps })
                })
                .collect();
            HttpResponse::Ok().json(res)
        }
        Err(e) => {
            error!("db error: {}", e);
            HttpResponse::InternalServerError().finish()
        }
    }
}

async fn create_pipeline(
    data: web::Data<AppState>,
    Json(cfg): web::Json<PipelineConfig>,
) -> impl Responder {
    let id = Uuid::new_v4();
    let json = serde_json::to_value(&cfg).unwrap();
    let name = cfg.name.clone();
    let steps = cfg.steps.clone();
    match sqlx::query("INSERT INTO pipelines (id, name, config_json) VALUES ($1,$2,$3)")
        .bind(id)
        .bind(&name)
        .bind(json)
        .execute(&data.pool)
        .await
    {
        Ok(_) => HttpResponse::Created().json(PipelineInfo { id, name, steps }),
        Err(e) => {
            error!("insert error: {}", e);
            HttpResponse::InternalServerError().finish()
        }
    }
}

async fn get_pipeline(data: web::Data<AppState>, path: web::Path<Uuid>) -> impl Responder {
    match sqlx::query("SELECT config_json FROM pipelines WHERE id=$1")
        .bind(*path)
        .fetch_one(&data.pool)
        .await
    {
        Ok(row) => {
            if let Ok(cfg) = serde_json::from_value::<PipelineConfig>(row.try_get("config_json").unwrap()) {
                HttpResponse::Ok().json(cfg)
            } else {
                HttpResponse::InternalServerError().finish()
            }
        }
        Err(_) => HttpResponse::NotFound().finish(),
    }
}

#[derive(Deserialize)]
struct NameInput { name: String }

async fn update_pipeline(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    Json(input): web::Json<NameInput>,
) -> impl Responder {
    let row = match sqlx::query("SELECT config_json FROM pipelines WHERE id=$1")
        .bind(*path)
        .fetch_one(&data.pool)
        .await
    {
        Ok(r) => r,
        Err(_) => return HttpResponse::NotFound().finish(),
    };
    let mut cfg: PipelineConfig = match serde_json::from_value(row.try_get("config_json").unwrap()) {
        Ok(c) => c,
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };
    cfg.name = input.name.clone();
    let json = serde_json::to_value(&cfg).unwrap();
    match sqlx::query("UPDATE pipelines SET name=$2, config_json=$3, updated_at=now() WHERE id=$1")
        .bind(*path)
        .bind(&cfg.name)
        .bind(json)
        .execute(&data.pool)
        .await
    {
        Ok(r) if r.rows_affected() == 1 => HttpResponse::NoContent().finish(),
        _ => HttpResponse::NotFound().finish(),
    }
}

async fn delete_pipeline(data: web::Data<AppState>, path: web::Path<Uuid>) -> impl Responder {
    match sqlx::query("DELETE FROM pipelines WHERE id=$1")
        .bind(*path)
        .execute(&data.pool)
        .await
    {
        Ok(r) if r.rows_affected() == 1 => HttpResponse::NoContent().finish(),
        _ => HttpResponse::NotFound().finish(),
    }
}

#[derive(Deserialize)]
struct StepInput { index: usize, step: PipelineStep }

async fn add_step(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    Json(input): web::Json<StepInput>,
) -> impl Responder {
    match fetch_config(&data.pool, *path).await {
        Ok(mut cfg) => {
            if input.index > cfg.steps.len() {
                return HttpResponse::BadRequest().finish();
            }
            cfg.steps.insert(input.index, input.step);
            match store_config(&data.pool, *path, &cfg).await {
                Ok(()) => HttpResponse::NoContent().finish(),
                Err(e) => e,
            }
        }
        Err(e) => e,
    }
}

#[derive(Deserialize)]
struct StepPatch {
    label: Option<Option<String>>,
    #[serde(rename = "type")]
    step_type: Option<shared::dto::PromptType>,
    prompt_id: Option<i32>,
    input_source: Option<Option<String>>,
    alias: Option<Option<String>>,
    inputs: Option<Option<Vec<String>>>,
    formula_override: Option<Option<String>>,
    condition: Option<Option<String>>,
    true_target: Option<Option<String>>,
    false_target: Option<Option<String>>,
    enum_targets: Option<Option<HashMap<String, String>>>,
    active: Option<bool>,
}

async fn update_step(
    data: web::Data<AppState>,
    path: web::Path<(Uuid, String)>,
    Json(patch): web::Json<StepPatch>,
) -> impl Responder {
    let (id, step_id) = path.into_inner();
    let mut cfg = match fetch_config(&data.pool, id).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let Some(step) = cfg.steps.iter_mut().find(|s| s.id == step_id) else { return HttpResponse::NotFound().finish(); };
    if let Some(v) = patch.label { step.label = v; }
    if let Some(v) = patch.step_type { step.step_type = v; }
    if let Some(v) = patch.prompt_id { step.prompt_id = v; }
    if let Some(v) = patch.input_source { step.input_source = v; }
    if let Some(v) = patch.alias { step.alias = v; }
    if let Some(v) = patch.inputs { step.inputs = v; }
    if let Some(v) = patch.formula_override { step.formula_override = v; }
    if let Some(v) = patch.condition { step.condition = v; }
    if let Some(v) = patch.true_target { step.true_target = v; }
    if let Some(v) = patch.false_target { step.false_target = v; }
    if let Some(v) = patch.enum_targets { step.enum_targets = v; }
    if let Some(v) = patch.active { step.active = Some(v); }
    match store_config(&data.pool, id, &cfg).await {
        Ok(()) => HttpResponse::NoContent().finish(),
        Err(e) => e,
    }
}

async fn delete_step(
    data: web::Data<AppState>,
    path: web::Path<(Uuid, String)>,
) -> impl Responder {
    let (id, step_id) = path.into_inner();
    let mut cfg = match fetch_config(&data.pool, id).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let orig_len = cfg.steps.len();
    cfg.steps.retain(|s| s.id != step_id);
    if cfg.steps.len() == orig_len {
        return HttpResponse::NotFound().finish();
    }
    match store_config(&data.pool, id, &cfg).await {
        Ok(()) => HttpResponse::NoContent().finish(),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
struct OrderInput { order: Vec<String> }

async fn reorder_steps(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    Json(input): web::Json<OrderInput>,
) -> impl Responder {
    let mut cfg = match fetch_config(&data.pool, *path).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    if input.order.len() != cfg.steps.len() {
        return HttpResponse::BadRequest().finish();
    }
    let mut map: HashMap<String, PipelineStep> = cfg.steps.into_iter().map(|s| (s.id.clone(), s)).collect();
    let mut new_steps = Vec::with_capacity(map.len());
    for id in input.order {
        match map.remove(&id) {
            Some(s) => new_steps.push(s),
            None => return HttpResponse::BadRequest().finish(),
        }
    }
    cfg.steps = new_steps;
    match store_config(&data.pool, *path, &cfg).await {
        Ok(()) => HttpResponse::NoContent().finish(),
        Err(e) => e,
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    let db_url = std::env::var("DATABASE_URL").expect("DATABASE_URL missing");
    let pool = PgPool::connect(&db_url).await.expect("db connect");
    let state = AppState { pool };
    info!("starting pipeline-api");
    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(state.clone()))
            .wrap(Cors::permissive())
            .route("/pipelines", web::get().to(list_pipelines))
            .route("/pipelines", web::post().to(create_pipeline))
            .service(
                web::resource("/pipelines/{id}")
                    .route(web::get().to(get_pipeline))
                    .route(web::put().to(update_pipeline))
                    .route(web::delete().to(delete_pipeline)),
            )
            .route("/pipelines/{id}/steps", web::put().to(add_step))
            .route("/pipelines/{id}/steps/order", web::put().to(reorder_steps))
            .service(
                web::resource("/pipelines/{id}/steps/{step_id}")
                    .route(web::patch().to(update_step))
                    .route(web::delete().to(delete_step)),
            )
    })
    .bind(("0.0.0.0", 8084))?
    .run()
    .await
}
