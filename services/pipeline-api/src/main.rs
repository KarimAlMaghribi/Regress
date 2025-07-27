use actix_cors::Cors;
use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use shared::dto::{PipelineConfig, PipelineStep};
use tracing::{info, error};

#[derive(Clone)]
struct AppState { pool: PgPool }

#[derive(Serialize)]
struct PipelineInfo {
    id: uuid::Uuid,
    name: String,
    steps: Vec<PipelineStep>,
}

async fn list_pipelines(data: web::Data<AppState>) -> impl Responder {
    let rows = sqlx::query!("SELECT id, name, config_json FROM pipelines")
        .fetch_all(&data.pool)
        .await;
    match rows {
        Ok(rows) => {
            let res: Vec<PipelineInfo> = rows
                .into_iter()
                .filter_map(|r| {
                    let cfg: PipelineConfig = serde_json::from_value(r.config_json).ok()?;
                    Some(PipelineInfo { id: r.id, name: cfg.name, steps: cfg.steps })
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
    let id = uuid::Uuid::new_v4();
    let json = serde_json::to_value(&cfg).unwrap();
    let name = cfg.name.clone();
    let steps = cfg.steps.clone();
    let res = sqlx::query!("INSERT INTO pipelines (id, name, config_json) VALUES ($1,$2,$3)", id, name, json)
        .execute(&data.pool)
        .await;
    match res {
        Ok(_) => HttpResponse::Created().json(PipelineInfo { id, name, steps }),
        Err(e) => {
            error!("insert error: {}", e);
            HttpResponse::InternalServerError().finish()
        }
    }
}

async fn get_pipeline(data: web::Data<AppState>, path: web::Path<uuid::Uuid>) -> impl Responder {
    match sqlx::query!("SELECT config_json FROM pipelines WHERE id=$1", *path)
        .fetch_one(&data.pool)
        .await
    {
        Ok(row) => {
            if let Ok(cfg) = serde_json::from_value::<PipelineConfig>(row.config_json) {
                HttpResponse::Ok().json(cfg)
            } else {
                HttpResponse::InternalServerError().finish()
            }
        }
        Err(_) => HttpResponse::NotFound().finish(),
    }
}

async fn update_pipeline(
    data: web::Data<AppState>,
    path: web::Path<uuid::Uuid>,
    Json(cfg): web::Json<PipelineConfig>,
) -> impl Responder {
    let json = serde_json::to_value(&cfg).unwrap();
    let name = cfg.name.clone();
    let steps = cfg.steps.clone();
    let res = sqlx::query!("UPDATE pipelines SET name=$2, config_json=$3, updated_at=now() WHERE id=$1", *path, name, json)
        .execute(&data.pool)
        .await;
    match res {
        Ok(r) if r.rows_affected() == 1 => HttpResponse::Ok().json(PipelineInfo { id: *path, name, steps }),
        _ => HttpResponse::NotFound().finish(),
    }
}

async fn delete_pipeline(data: web::Data<AppState>, path: web::Path<uuid::Uuid>) -> impl Responder {
    let res = sqlx::query!("DELETE FROM pipelines WHERE id=$1", *path)
        .execute(&data.pool)
        .await;
    match res {
        Ok(r) if r.rows_affected() == 1 => HttpResponse::NoContent().finish(),
        _ => HttpResponse::NotFound().finish(),
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
    })
    .bind(("0.0.0.0", 8090))?
    .run()
    .await
}
