use actix_cors::Cors;
use actix_web::web::Json;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use rdkafka::consumer::{Consumer, StreamConsumer};
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::{ClientConfig, Message};
use serde::{Deserialize, Serialize};
use serde_json::json;
use shared::dto::{
    PdfUploaded, PipelineConfig, PipelineRunResult, PipelineStep, PromptType, RunStep,
};
use shared::kafka;
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use std::collections::{BTreeSet, HashMap};
use std::time::Duration;
use tracing::{error, info, warn};
use uuid::Uuid;

// ▼▼▼ Konsolidierung
mod consolidation;
use consolidation::{
    ConsCfg, FieldType, CanonicalField, ScoreOutcome, DecisionOutcome,
    consolidate_field, consolidate_scoring_weighted, consolidate_decision_generic,
};
// ▲▲▲

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

// einfacher Slug für Keys (aus Prompt-Text)
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

// Key-Ermittlung für ein Prompt-Ergebnis
fn key_for_prompt<'a>(items: impl IntoIterator<Item = &'a shared::dto::PromptResult>, prompt_id: i64) -> String {
    // 1) bevorzugt json_key wenn gesetzt
    if let Some(k) = items
        .into_iter()
        .find(|r| r.prompt_id == prompt_id)
        .and_then(|r| r.json_key.clone())
    {
        return slugify(&k);
    }
    // 2) fallback: prompt_text sluggified
    let mut prompt_text = "prompt".to_string();
    for r in items {
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

    if let Err(e) = sqlx::query("ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS config_json JSONB")
        .execute(pool)
        .await
    {
        error!(%e, "failed to ensure column config_json");
    }

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
    let res =
        sqlx::query("UPDATE pipelines SET name=$2, config_json=$3, updated_at=now() WHERE id=$1")
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
                    let cfg: PipelineConfig =
                        serde_json::from_value(r.try_get::<serde_json::Value, _>("config_json").ok()?).ok()?;
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

#[derive(sqlx::FromRow)]
struct RunMeta {
    pipeline_id: uuid::Uuid,
    pdf_id: i32,
    overall_score: Option<f32>,
    extracted: Option<serde_json::Value>,
}

async fn get_run(data: web::Data<AppState>, path: web::Path<uuid::Uuid>) -> impl Responder {
    let id = path.into_inner();
    let meta = match sqlx::query_as::<_, RunMeta>(
        "SELECT pipeline_id, pdf_id, overall_score, extracted FROM pipeline_runs WHERE id=$1",
    )
        .bind(id)
        .fetch_one(&data.pool)
        .await
    {
        Ok(m) => m,
        Err(_) => return HttpResponse::NotFound().finish(),
    };

    let step_rows = sqlx::query(
        r#"SELECT seq_no,
                  step_id,
                  prompt_id,
                  prompt_type,
                  decision_key,
                  route,
                  result
           FROM pipeline_run_steps WHERE run_id=$1 ORDER BY seq_no"#,
    )
        .bind(id)
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

    let extracted_map = meta
        .extracted
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
        .into_iter()
        .collect();

    let res = PipelineRunResult {
        pdf_id: meta.pdf_id,
        pipeline_id: meta.pipeline_id,
        overall_score: meta.overall_score,
        extracted: extracted_map,
        extraction: vec![],
        scoring: vec![],
        decision: vec![],
        log: steps,
    };
    HttpResponse::Ok().json(res)
}

async fn create_pipeline(
    data: web::Data<AppState>,
    Json(cfg): web::Json<PipelineConfig>,
) -> impl Responder {
    let id = Uuid::new_v4();
    let name = cfg.name.clone();
    let steps = cfg.steps.clone();

    let json = match serde_json::to_value(&cfg) {
        Ok(v) => v,
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };

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

    let mut cfg: PipelineConfig = match row.try_get("config_json") {
        Ok(val) => match serde_json::from_value(val) {
            Ok(c) => c,
            Err(_) => return HttpResponse::InternalServerError().finish(),
        },
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };

    cfg.name = input.name.clone();

    let json = match serde_json::to_value(&cfg) {
        Ok(v) => v,
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };

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
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
struct StepPatch {
    #[serde(rename = "type")]
    step_type: Option<shared::dto::PromptType>,
    prompt_id: Option<i64>,
    route: Option<Option<String>>,
    yes_key: Option<Option<String>>,
    no_key: Option<Option<String>>,
    active: Option<bool>,
    #[serde(flatten)]
    _extras: std::collections::HashMap<String, serde_json::Value>,
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
    let Some(step) = cfg.steps.iter_mut().find(|s| s.id == step_id) else {
        return HttpResponse::NotFound().finish();
    };
    if let Some(v) = patch.step_type { step.step_type = v; }
    if let Some(v) = patch.prompt_id { step.prompt_id = v; }
    if let Some(v) = patch.route     { step.route = v; }
    if let Some(v) = patch.yes_key   { step.yes_key = v; }
    if let Some(v) = patch.no_key    { step.no_key = v; }
    if let Some(v) = patch.active    { step.active = v; }
    match store_config(&data.pool, id, &cfg).await {
        Ok(()) => HttpResponse::NoContent().finish(),
        Err(e) => e,
    }
}

async fn delete_step(data: web::Data<AppState>, path: web::Path<(Uuid, String)>) -> impl Responder {
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
    let mut map: HashMap<String, PipelineStep> =
        cfg.steps.into_iter().map(|s| (s.id.clone(), s)).collect();
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

#[derive(Deserialize)]
struct RunInput { file_id: i32 }

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

    let payload = match serde_json::to_string(&PdfUploaded { pdf_id, pipeline_id: *path }) {
        Ok(p) => p,
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };

    let _ = data
        .producer
        .send(FutureRecord::to("pipeline-run").payload(&payload).key(&()), Duration::from_secs(0))
        .await;

    // Best-effort: auf "pipeline-result" warten und sofort konsolidieren + persistieren
    let group = format!("pipeline-api-{}", Uuid::new_v4());
    if let Ok(consumer) = ClientConfig::new()
        .set("group.id", &group)
        .set("bootstrap.servers", &data.broker)
        .create::<StreamConsumer>()
    {
        if let Err(e) = consumer.subscribe(&["pipeline-result"]) {
            warn!(%e, "failed to subscribe to pipeline-result");
        } else if let Ok(Ok(msg)) = tokio::time::timeout(Duration::from_secs(30), consumer.recv()).await {
            if let Some(Ok(p)) = msg.payload_view::<str>() {
                if let Ok(mut res) = serde_json::from_str::<PipelineRunResult>(p) {
                    if res.pdf_id == pdf_id && res.pipeline_id == *path {
                        // ▼ Konsolidierung
                        let cfgc = ConsCfg::default();

                        // Extraction: je Prompt-ID genau 1 Feld
                        let mut final_extracted: HashMap<String, serde_json::Value> = HashMap::new();
                        let mut ids: BTreeSet<i64> = res.extraction.iter().map(|r| r.prompt_id).collect();
                        for pid in ids.drain() {
                            if let Some(canon) = consolidate_field(&res.extraction, pid as i32, FieldType::Auto, &cfgc) {
                                let key = key_for_prompt(res.extraction.iter(), pid);
                                final_extracted.insert(key, serde_json::to_value(canon).unwrap());
                            }
                        }

                        // Scoring
                        let mut final_scores: HashMap<String, serde_json::Value> = HashMap::new();
                        let mut sids: BTreeSet<i32> = res.scoring.iter().map(|r| r.prompt_id).collect();
                        for pid in sids.drain() {
                            let outcome = consolidate_scoring_weighted(&res.scoring, pid, None, &cfgc);
                            if let Some(o) = outcome {
                                let key = format!("score_{}", pid);
                                final_scores.insert(key, serde_json::to_value(o).unwrap());
                            }
                        }

                        // Decision
                        let mut final_decisions: HashMap<String, serde_json::Value> = HashMap::new();
                        let mut dids: BTreeSet<i64> = res.decision.iter().map(|r| r.prompt_id).collect();
                        for pid in dids.drain() {
                            let outcome = consolidate_decision_generic(&res.decision, pid as i32, None, &cfgc);
                            if let Some(o) = outcome {
                                let key = format!("decision_{}", pid);
                                final_decisions.insert(key, serde_json::to_value(o).unwrap());
                            }
                        }

                        // Review-Flag
                        let mut review_required = false;
                        for v in final_extracted.values() {
                            if let Some(c) = v.get("confidence").and_then(|x| x.as_f64()) {
                                if c < cfgc.min_confidence as f64 { review_required = true; break; }
                            }
                        }
                        if !review_required {
                            for v in final_scores.values() {
                                if let Some(c) = v.get("confidence").and_then(|x| x.as_f64()) {
                                    if c < cfgc.min_confidence as f64 { review_required = true; break; }
                                }
                            }
                        }
                        if !review_required {
                            for v in final_decisions.values() {
                                if let Some(c) = v.get("confidence").and_then(|x| x.as_f64()) {
                                    if c < cfgc.min_confidence as f64 { review_required = true; break; }
                                }
                            }
                        }

                        // ▼ Persistenz in pipeline_runs
                        let ext_json  = serde_json::to_value(&final_extracted).unwrap_or(json!({}));
                        let scor_json = serde_json::to_value(&final_scores).unwrap_or(json!({}));
                        let dec_json  = serde_json::to_value(&final_decisions).unwrap_or(json!({}));

                        // run_id robust aus der rohen Nachricht holen (falls im DTO nicht vorhanden)
                        let run_id_opt: Option<Uuid> = serde_json::from_str::<serde_json::Value>(p)
                            .ok()
                            .and_then(|v| v.get("run_id").or_else(|| v.get("id")))
                            .and_then(|x| x.as_str())
                            .and_then(|s| Uuid::parse_str(s).ok());

                        if let Some(run_id) = run_id_opt {
                            // Versuch mit final_* Spalten
                            let upd = sqlx::query(
                                r#"UPDATE pipeline_runs
                                   SET extracted = $1,
                                       final_scores = $2,
                                       final_decisions = $3,
                                       review_required = $4,
                                       updated_at = now()
                                   WHERE id = $5"#,
                            )
                                .bind(&ext_json)
                                .bind(&scor_json)
                                .bind(&dec_json)
                                .bind(review_required)
                                .bind(run_id)
                                .execute(&data.pool)
                                .await;

                            if upd.is_err() {
                                // Fallback: nur extracted (falls Migration noch fehlt)
                                let _ = sqlx::query(
                                    r#"UPDATE pipeline_runs
                                       SET extracted = $1, updated_at = now()
                                       WHERE id = $2"#,
                                )
                                    .bind(&ext_json)
                                    .bind(run_id)
                                    .execute(&data.pool)
                                    .await;
                            }
                        } else {
                            // Fallback: jüngster Run für (pdf_id, pipeline_id)
                            let upd = sqlx::query(
                                r#"UPDATE pipeline_runs pr SET
                                       extracted = $1,
                                       final_scores = $2,
                                       final_decisions = $3,
                                       review_required = $4,
                                       updated_at = now()
                                   FROM (
                                       SELECT id FROM pipeline_runs
                                       WHERE pdf_id = $5 AND pipeline_id = $6
                                       ORDER BY id DESC
                                       LIMIT 1
                                   ) last
                                   WHERE pr.id = last.id"#,
                            )
                                .bind(&ext_json)
                                .bind(&scor_json)
                                .bind(&dec_json)
                                .bind(review_required)
                                .bind(res.pdf_id)
                                .bind(res.pipeline_id)
                                .execute(&data.pool)
                                .await;

                            if upd.is_err() {
                                // Minimaler Fallback
                                let _ = sqlx::query(
                                    r#"UPDATE pipeline_runs pr SET
                                           extracted = $1,
                                           updated_at = now()
                                       FROM (
                                           SELECT id FROM pipeline_runs
                                           WHERE pdf_id = $2 AND pipeline_id = $3
                                           ORDER BY id DESC
                                           LIMIT 1
                                       ) last
                                       WHERE pr.id = last.id"#,
                                )
                                    .bind(&ext_json)
                                    .bind(res.pdf_id)
                                    .bind(res.pipeline_id)
                                    .execute(&data.pool)
                                    .await;
                            }
                        }

                        // Finale Antwort
                        let final_payload = json!({
                            "pdf_id": res.pdf_id,
                            "pipeline_id": res.pipeline_id,
                            "overall_score": res.overall_score,
                            "extracted": final_extracted,
                            "extraction": res.extraction,
                            "scoring": res.scoring,
                            "decision": res.decision,
                            "log": res.log,
                            "scores": final_scores,
                            "decisions": final_decisions,
                            "review_required": review_required
                        });

                        return HttpResponse::Ok().json(final_payload);
                    }
                }
            }
        }
    }

    HttpResponse::Accepted().finish()
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

    let state = AppState { pool, producer, broker: settings.message_broker_url.clone() };

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
