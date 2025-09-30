use actix_cors::Cors;
use actix_web::web::Json;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::ClientConfig;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use shared::dto::{PdfUploaded, PipelineConfig, PipelineStep, PromptType, RunStep};
use shared::kafka;
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::collections::HashMap;
use std::time::Duration;
use tracing::{error, info, warn};
use uuid::Uuid;

mod consolidation; // belassen, falls später genutzt

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    producer: FutureProducer,
    broker: String,
}

#[derive(Serialize)]
struct PipelineInfo {
    id: Uuid,
    name: String,
    steps: Vec<PipelineStep>,
}

/* ------------------------------ Helpers ------------------------------ */

fn ensure_sslmode_disable(url: &str) -> String {
    if url.contains("sslmode=") {
        url.to_string()
    } else if url.contains('?') {
        format!("{url}&sslmode=disable")
    } else {
        format!("{url}?sslmode=disable")
    }
}

fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_us = false;
    for ch in s.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_us = false;
        } else if !last_us {
            out.push('_');
            last_us = true;
        }
    }
    out.trim_matches('_').to_string()
}

fn key_for_prompt(items: &[shared::dto::PromptResult], prompt_id: i32) -> String {
    if let Some(k) = items
        .iter()
        .find(|r| r.prompt_id == prompt_id)
        .and_then(|r| r.json_key.clone())
    {
        return slugify(&k);
    }
    let mut prompt_text = "prompt".to_string();
    for r in items.iter() {
        if r.prompt_id == prompt_id {
            prompt_text = r.prompt_text.clone();
            break;
        }
    }
    format!("{}_{}", slugify(&prompt_text), prompt_id)
}

/* ------------------------------ DB Init ------------------------------ */

async fn init_db(pool: &PgPool) {
    if let Err(e) = sqlx::query(
        "CREATE TABLE IF NOT EXISTS pipelines (
            id UUID PRIMARY KEY,
            name TEXT NOT NULL,
            config_json JSONB NOT NULL,
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now()
        )",
    )
        .execute(pool)
        .await
    {
        error!(%e, "failed to create table pipelines");
    }

    let _ = sqlx::query("ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS config_json JSONB")
        .execute(pool)
        .await;

    info!("ensured pipelines table exists");
}

/* ------------------------------ Config R/W ------------------------------ */

async fn fetch_config(pool: &PgPool, id: Uuid) -> Result<PipelineConfig, HttpResponse> {
    let row = sqlx::query("SELECT config_json FROM pipelines WHERE id=$1")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(|_| HttpResponse::NotFound().finish())?;

    let value: serde_json::Value = row
        .try_get("config_json")
        .map_err(|_| HttpResponse::InternalServerError().finish())?;
    serde_json::from_value(value).map_err(|_| HttpResponse::InternalServerError().finish())
}

async fn store_config(pool: &PgPool, id: Uuid, cfg: &PipelineConfig) -> Result<(), HttpResponse> {
    let json = serde_json::to_value(cfg).map_err(|_| HttpResponse::InternalServerError().finish())?;
    let res = sqlx::query("UPDATE pipelines SET name=$2, config_json=$3, updated_at=now() WHERE id=$1")
        .bind(id)
        .bind(&cfg.name)
        .bind(json)
        .execute(pool)
        .await
        .map_err(|_| HttpResponse::InternalServerError().finish())?;
    if res.rows_affected() == 1 {
        Ok(())
    } else {
        Err(HttpResponse::NotFound().finish())
    }
}

/* ------------------------------ Handlers ------------------------------ */

async fn list_pipelines(data: web::Data<AppState>) -> impl Responder {
    match sqlx::query("SELECT id, name, config_json FROM pipelines")
        .fetch_all(&data.pool)
        .await
    {
        Ok(rows) => {
            let res: Vec<PipelineInfo> = rows
                .into_iter()
                .filter_map(|r| {
                    let cfg: PipelineConfig = serde_json::from_value(
                        r.try_get::<serde_json::Value, _>("config_json").ok()?,
                    )
                        .ok()?;
                    let id: Uuid = r.try_get("id").ok()?;
                    Some(PipelineInfo {
                        id,
                        name: cfg.name,
                        steps: cfg.steps,
                    })
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

#[derive(sqlx::FromRow)]
struct RunMetaRow {
    pipeline_id: uuid::Uuid,
    pdf_id: i32,
    overall_score: Option<f32>,
}

async fn get_run(data: web::Data<AppState>, path: web::Path<uuid::Uuid>) -> impl Responder {
    let run_id = path.into_inner();

    let meta = match sqlx::query_as::<_, RunMetaRow>(
        "SELECT pipeline_id, pdf_id, overall_score FROM pipeline_runs WHERE id=$1",
    )
        .bind(run_id)
        .fetch_one(&data.pool)
        .await
    {
        Ok(m) => m,
        Err(_) => return HttpResponse::NotFound().finish(),
    };

    let final_rows = match sqlx::query(
        r#"
        SELECT prompt_type, final_key, result
        FROM pipeline_run_steps
        WHERE run_id=$1 AND is_final = TRUE
        ORDER BY prompt_type, final_key
        "#,
    )
        .bind(run_id)
        .fetch_all(&data.pool)
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            error!("db error finals: {}", e);
            return HttpResponse::InternalServerError().finish();
        }
    };

    let mut extracted: Map<String, Value> = Map::new();
    let mut scores: Map<String, Value> = Map::new();
    let mut decisions: Map<String, Value> = Map::new();

    for r in final_rows {
        let ptype: String = r.try_get("prompt_type").unwrap_or_default();
        let key: String = r
            .try_get::<Option<String>, _>("final_key")
            .unwrap_or(None)
            .unwrap_or_default();
        let val: Value = r.try_get("result").unwrap_or(json!({}));
        if key.is_empty() {
            continue;
        }
        match ptype.as_str() {
            "ExtractionPrompt" => {
                extracted.insert(key, val);
            }
            "ScoringPrompt" => {
                scores.insert(key, val);
            }
            "DecisionPrompt" => {
                decisions.insert(key, val);
            }
            _ => {}
        }
    }

    let step_rows = sqlx::query(
        r#"SELECT seq_no, step_id, prompt_id, prompt_type, decision_key, route, result
           FROM pipeline_run_steps WHERE run_id=$1 ORDER BY seq_no"#,
    )
        .bind(run_id)
        .fetch_all(&data.pool)
        .await
        .unwrap_or_default();

    let steps: Vec<RunStep> = step_rows
        .into_iter()
        .map(|row| {
            let prompt_type: PromptType = row
                .try_get::<String, _>("prompt_type")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(PromptType::ExtractionPrompt);

            RunStep {
                seq_no: row.try_get::<i32, _>("seq_no").unwrap_or_default() as u32,
                step_id: row.try_get::<String, _>("step_id").unwrap_or_default(),
                prompt_id: row.try_get::<i64, _>("prompt_id").unwrap_or_default(),
                prompt_type,
                decision_key: row.try_get("decision_key").ok(),
                route: row.try_get("route").ok(),
                result: row.try_get("result").unwrap_or_default(),
            }
        })
        .collect();

    let res_json = json!({
        "pdf_id": meta.pdf_id,
        "pipeline_id": meta.pipeline_id,
        "overall_score": meta.overall_score,
        "extracted": extracted,
        "scores": scores,
        "decisions": decisions,
        "extraction": [],
        "scoring":   [],
        "decision":  [],
        "log": steps
    });

    HttpResponse::Ok().json(res_json)
}

#[derive(Deserialize)]
struct NameInput {
    name: String,
}

async fn create_pipeline(
    data: web::Data<AppState>,
    Json(cfg): web::Json<PipelineConfig>,
) -> impl Responder {
    let id = Uuid::new_v4();
    let name = cfg.name.clone();
    let steps = cfg.steps.clone();

    let jsonv = match serde_json::to_value(&cfg) {
        Ok(v) => v,
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };

    match sqlx::query("INSERT INTO pipelines (id, name, config_json) VALUES ($1,$2,$3)")
        .bind(id)
        .bind(&name)
        .bind(jsonv)
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
        Ok(row) => match row.try_get("config_json") {
            Ok(val) => match serde_json::from_value::<PipelineConfig>(val) {
                Ok(cfg) => HttpResponse::Ok().json(cfg),
                Err(_) => HttpResponse::InternalServerError().finish(),
            },
            Err(_) => HttpResponse::InternalServerError().finish(),
        },
        Err(_) => HttpResponse::NotFound().finish(),
    }
}

/// Update-Endpoint, der **Name-only** ODER **volle Pipeline** akzeptiert.
/// - Wenn Body { "name": "..." } ist → nur Name setzen.
/// - Wenn Body ein PipelineConfig ist → komplette Pipeline ersetzen.
async fn update_pipeline(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    Json(body): web::Json<Value>,
) -> impl Responder {
    // Versuch: als volle Pipeline interpretieren
    if body.get("steps").is_some() {
        let cfg: PipelineConfig = match serde_json::from_value(body.clone()) {
            Ok(c) => c,
            Err(_) => return HttpResponse::BadRequest().finish(),
        };
        return match store_config(&data.pool, *path, &cfg).await {
            Ok(()) => HttpResponse::NoContent().finish(),
            Err(e) => e,
        };
    }

    // Fallback: Name-only
    let input: NameInput = match serde_json::from_value(body) {
        Ok(n) => n,
        Err(_) => return HttpResponse::BadRequest().finish(),
    };

    let row = match sqlx::query("SELECT config_json FROM pipelines WHERE id=$1")
        .bind(*path)
        .fetch_one(&data.pool)
        .await
    {
        Ok(r) => r,
        Err(_) => return HttpResponse::NotFound().finish(),
    };

    let mut cfg: PipelineConfig = match row.try_get("config_json") {
        Ok(val) => match serde_json::from_value(val) {
            Ok(c) => c,
            Err(_) => return HttpResponse::InternalServerError().finish(),
        },
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };

    cfg.name = input.name.clone();

    match store_config(&data.pool, *path, &cfg).await {
        Ok(()) => HttpResponse::NoContent().finish(),
        Err(e) => e,
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
#[serde(rename_all = "camelCase")]
struct StepInput {
    index: usize,
    step: PipelineStep,
}

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
#[serde(rename_all = "camelCase")]
struct StepPatch {
    #[serde(rename = "type")]
    step_type: Option<shared::dto::PromptType>,
    #[serde(alias = "promptId", alias = "prompt_id")]
    prompt_id: Option<i64>,
    route: Option<Option<String>>,
    #[serde(alias = "yesKey", alias = "yes_key")]
    yes_key: Option<Option<String>>,
    #[serde(alias = "noKey", alias = "no_key")]
    no_key: Option<Option<String>>,
    active: Option<bool>,
    // z. B. { "min_signal": 0.5 }
    config: Option<Value>,
}

async fn update_step(
    data: web::Data<AppState>,
    path: web::Path<(Uuid, String)>,
    Json(patch): web::Json<StepPatch>,
) -> impl Responder {
    let (id, step_id_str) = path.into_inner();

    let step_uuid = match Uuid::parse_str(&step_id_str) {
        Ok(u) => u,
        Err(_) => return HttpResponse::BadRequest().finish(),
    };

    let mut cfg = match fetch_config(&data.pool, id).await {
        Ok(c) => c,
        Err(e) => return e,
    };

    let Some(step) = cfg.steps.iter_mut().find(|s| s.id == step_uuid) else {
        return HttpResponse::NotFound().finish();
    };

    if let Some(v) = patch.step_type {
        step.step_type = v;
    }
    if let Some(v) = patch.prompt_id {
        step.prompt_id = v as i32; // i64 → i32
    }
    if let Some(v) = patch.route {
        step.route = v;
    }
    if let Some(v) = patch.yes_key {
        step.yes_key = v;
    }
    if let Some(v) = patch.no_key {
        step.no_key = v;
    }
    if let Some(v) = patch.active {
        step.active = v;
    }
    if let Some(v) = patch.config {
        step.config = Some(v);
    }

    match store_config(&data.pool, id, &cfg).await {
        Ok(()) => HttpResponse::NoContent().finish(),
        Err(e) => e,
    }
}

async fn delete_step(data: web::Data<AppState>, path: web::Path<(Uuid, String)>) -> impl Responder {
    let (id, step_id_str) = path.into_inner();
    let step_uuid = match Uuid::parse_str(&step_id_str) {
        Ok(u) => u,
        Err(_) => return HttpResponse::BadRequest().finish(),
    };

    let mut cfg = match fetch_config(&data.pool, id).await {
        Ok(c) => c,
        Err(e) => return e,
    };

    let orig_len = cfg.steps.len();
    cfg.steps.retain(|s| s.id != step_uuid);
    if cfg.steps.len() == orig_len {
        return HttpResponse::NotFound().finish();
    }

    match store_config(&data.pool, id, &cfg).await {
        Ok(()) => HttpResponse::NoContent().finish(),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
struct OrderInput {
    order: Vec<String>, // Step-IDs als String (UUIDs)
}

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

    let mut map: HashMap<Uuid, PipelineStep> =
        cfg.steps.into_iter().map(|s| (s.id, s)).collect();

    let mut new_steps: Vec<PipelineStep> = Vec::with_capacity(map.len());
    for id_str in input.order.iter() {
        let uid = match Uuid::parse_str(id_str) {
            Ok(u) => u,
            Err(_) => return HttpResponse::BadRequest().finish(),
        };
        match map.remove(&uid) {
            Some(step) => new_steps.push(step),
            None => return HttpResponse::BadRequest().finish(),
        }
    }

    cfg.steps = new_steps;

    match store_config(&data.pool, *path, &cfg).await {
        Ok(()) => HttpResponse::NoContent().finish(),
        Err(e) => e,
    }
}

#[derive(Deserialize)]
struct RunInput {
    file_id: i32,
}

async fn run_pipeline(
    data: web::Data<AppState>,
    path: web::Path<Uuid>,
    Json(input): web::Json<RunInput>,
) -> impl Responder {
    let row = match sqlx::query("SELECT pdf_id FROM uploads WHERE id=$1")
        .bind(input.file_id)
        .fetch_one(&data.pool)
        .await
    {
        Ok(r) => r,
        Err(_) => return HttpResponse::NotFound().finish(),
    };
    let pdf_id: i32 = match row.try_get("pdf_id") {
        Ok(v) => v,
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };

    let _ = sqlx::query("UPDATE uploads SET pipeline_id=$1 WHERE id=$2")
        .bind(*path)
        .bind(input.file_id)
        .execute(&data.pool)
        .await;

    let payload =
        match serde_json::to_string(&PdfUploaded { pdf_id, pipeline_id: *path }) {
            Ok(p) => p,
            Err(_) => return HttpResponse::InternalServerError().finish(),
        };

    let _ = data
        .producer
        .send(
            FutureRecord::to("pipeline-run").payload(&payload).key(&()),
            Duration::from_secs(0),
        )
        .await;

    HttpResponse::Accepted().json(json!({
        "status": "queued",
        "pdf_id": pdf_id,
        "pipeline_id": *path
    }))
}

/* ------------------------------ main ------------------------------ */

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();

    let settings = match shared::config::Settings::new() {
        Ok(s) => s,
        Err(e) => {
            error!(%e, "failed to load settings");
            std::process::exit(1);
        }
    };

    let topics = ["pipeline-run", "pipeline-result"];
    if let Err(e) = kafka::ensure_topics(&settings.message_broker_url, &topics).await {
        warn!(%e, "failed to ensure kafka topics (continuing)");
    }

    let db_url = ensure_sslmode_disable(&settings.database_url);
    if db_url != settings.database_url {
        warn!("DATABASE_URL had no sslmode – using '{}'", db_url);
    }

    let pool = match PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&db_url)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            error!(%e, "failed to connect to Postgres");
            std::process::exit(1);
        }
    };

    init_db(&pool).await;

    let producer: FutureProducer = match ClientConfig::new()
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
    {
        Ok(p) => p,
        Err(e) => {
            error!(%e, "failed to create kafka producer");
            std::process::exit(1);
        }
    };

    let state = AppState {
        pool,
        producer,
        broker: settings.message_broker_url.clone(),
    };

    info!("starting pipeline-api on 0.0.0.0:8084");

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
            .route("/pipelines/{id}/run", web::post().to(run_pipeline))
            .service(
                web::resource("/pipelines/{id}/steps/{step_id}")
                    .route(web::patch().to(update_step))
                    .route(web::delete().to(delete_step)),
            )
            .route("/runs/{id}", web::get().to(get_run))
    })
        .bind(("0.0.0.0", 8084))?
        .run()
        .await
}
