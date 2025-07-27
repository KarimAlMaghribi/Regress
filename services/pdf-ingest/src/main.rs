use actix_cors::Cors;
use actix_multipart::Multipart;
use actix_web::http::header;
use actix_web::web::Bytes;
use actix_web::{web, App, Error, HttpResponse, HttpServer, Responder};
use futures_util::StreamExt as _;
use rdkafka::{
    producer::{FutureProducer, FutureRecord},
    ClientConfig,
};
use shared::config::Settings;
use shared::dto::{PdfUploaded, UploadResponse};
use uuid::Uuid;
use std::time::Duration;
use postgres_native_tls::MakeTlsConnector;
use native_tls::TlsConnector;
use tracing::info;
use lopdf::{Document, Bookmark, Object, ObjectId};
use zip::ZipArchive;
use std::collections::BTreeMap;
use serde::Serialize;

#[derive(Serialize)]
struct UploadEntry {
    id: i32,
    pdf_id: Option<i32>,
    status: String,
}
fn merge_documents(documents: Vec<Document>) -> std::io::Result<Vec<u8>> {
    let mut max_id = 1;
    let mut pagenum = 1;
    let mut documents_pages = BTreeMap::new();
    let mut documents_objects = BTreeMap::new();
    let mut document = Document::with_version("1.5");

    for mut doc in documents {
        let mut first = false;
        doc.renumber_objects_with(max_id);
        max_id = doc.max_id + 1;
        documents_pages.extend(
            doc.get_pages()
                .into_values()
                .map(|object_id| {
                    if !first {
                        let bookmark = Bookmark::new(
                            format!("Page_{}", pagenum),
                            [0.0, 0.0, 1.0],
                            0,
                            object_id,
                        );
                        document.add_bookmark(bookmark, None);
                        first = true;
                        pagenum += 1;
                    }

                    (object_id, doc.get_object(object_id).unwrap().to_owned())
                })
                .collect::<BTreeMap<ObjectId, Object>>(),
        );
        documents_objects.extend(doc.objects);
    }

    let mut catalog_object: Option<(ObjectId, Object)> = None;
    let mut pages_object: Option<(ObjectId, Object)> = None;

    for (object_id, object) in documents_objects.iter() {
        match object.type_name().unwrap_or(b"") {
            b"Catalog" => {
                catalog_object = Some((catalog_object.map(|c| c.0).unwrap_or(*object_id), object.clone()));
            }
            b"Pages" => {
                if let Ok(dictionary) = object.as_dict() {
                    let mut dictionary = dictionary.clone();
                    if let Some((_, ref object)) = pages_object {
                        if let Ok(old_dictionary) = object.as_dict() {
                            dictionary.extend(old_dictionary);
                        }
                    }
                    pages_object = Some((pages_object.map(|p| p.0).unwrap_or(*object_id), Object::Dictionary(dictionary)));
                }
            }
            b"Page" => {}
            b"Outlines" => {}
            b"Outline" => {}
            _ => {
                document.objects.insert(*object_id, object.clone());
            }
        }
    }

    if pages_object.is_none() {
        return Ok(Vec::new());
    }

    for (object_id, object) in documents_pages.iter() {
        if let Ok(dictionary) = object.as_dict() {
            let mut dictionary = dictionary.clone();
            dictionary.set("Parent", pages_object.as_ref().unwrap().0);
            document
                .objects
                .insert(*object_id, Object::Dictionary(dictionary));
        }
    }

    if catalog_object.is_none() {
        return Ok(Vec::new());
    }

    let catalog_object = catalog_object.unwrap();
    let pages_object = pages_object.unwrap();
    if let Ok(dictionary) = pages_object.1.as_dict() {
        let mut dictionary = dictionary.clone();
        dictionary.set("Count", documents_pages.len() as u32);
        dictionary.set(
            "Kids",
            documents_pages
                .into_keys()
                .map(Object::Reference)
                .collect::<Vec<_>>(),
        );
        document
            .objects
            .insert(pages_object.0, Object::Dictionary(dictionary));
    }

    if let Ok(dictionary) = catalog_object.1.as_dict() {
        let mut dictionary = dictionary.clone();
        dictionary.set("Pages", pages_object.0);
        dictionary.remove(b"Outlines");
        document
            .objects
            .insert(catalog_object.0, Object::Dictionary(dictionary));
    }
    document.trailer.set("Root", catalog_object.0);
    document.max_id = document.objects.len() as u32;
    document.renumber_objects();
    document.adjust_zero_pages();
    if let Some(n) = document.build_outline() {
        if let Ok(Object::Dictionary(ref mut dict)) = document.get_object_mut(catalog_object.0) {
            dict.set("Outlines", Object::Reference(n));
        }
    }
    document.compress();
    let mut buf = Vec::new();
    document.save_to(&mut buf)?;
    Ok(buf)
}
async fn upload(
    mut payload: Multipart,
    db: web::Data<tokio_postgres::Client>,
    producer: web::Data<FutureProducer>,
) -> Result<HttpResponse, Error> {
    info!("handling upload request");
    let stmt = db
        .prepare("INSERT INTO uploads (status) VALUES ('merging') RETURNING id")
        .await
        .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
    let row = db
        .query_one(&stmt, &[])
        .await
        .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
    let upload_id: i32 = row.get(0);
    let mut files: Vec<(Vec<u8>, String)> = Vec::new();
    let mut prompt = String::new();
    let mut pipeline_id: Option<String> = None;
    while let Some(item) = payload.next().await {
        let mut field = item?;
        if field.name() == "file" {
            let filename = field
                .content_disposition()
                .get_filename()
                .map(|f| f.to_string())
                .unwrap_or_default();
            let mut buf = Vec::new();
            while let Some(chunk) = field.next().await {
                let bytes: Bytes = chunk?;
                buf.extend_from_slice(&bytes);
            }
            if filename.to_lowercase().ends_with(".zip") {
                let reader = std::io::Cursor::new(buf);
                let mut zip = ZipArchive::new(reader)
                    .map_err(|e| actix_web::error::ErrorBadRequest(e.to_string()))?;
                for i in 0..zip.len() {
                    let mut f = zip
                        .by_index(i)
                        .map_err(|e| actix_web::error::ErrorBadRequest(e.to_string()))?;
                    if f.name().to_lowercase().ends_with(".pdf") {
                        let mut data = Vec::new();
                        std::io::copy(&mut f, &mut data)
                            .map_err(|e| actix_web::error::ErrorBadRequest(e.to_string()))?;
                        files.push((data, f.name().to_string()));
                    }
                }
            } else {
                files.push((buf, filename));
            }
        } else if field.name() == "prompts" {
            while let Some(chunk) = field.next().await {
                let bytes: Bytes = chunk?;
                prompt.push_str(std::str::from_utf8(&bytes).unwrap_or_default());
            }
        } else if field.name() == "pipeline_id" {
            while let Some(chunk) = field.next().await {
                let bytes: Bytes = chunk?;
                pipeline_id = Some(std::str::from_utf8(&bytes).unwrap_or_default().to_string());
            }
        }
    }
    if !files.is_empty() {
        let data = if files.len() == 1 {
            files[0].0.clone()
        } else {
            let docs = files
                .iter()
                .map(|(d, _)| Document::load_mem(d).unwrap())
                .collect();
            merge_documents(docs).map_err(|e| actix_web::error::ErrorInternalServerError(e))?
        };
        info!(bytes = data.len(), "storing pdf");
        let stmt = db
            .prepare("INSERT INTO pdfs (data) VALUES ($1) RETURNING id")
            .await
            .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
        let row = db
            .query_one(&stmt, &[&data])
            .await
            .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
        let id: i32 = row.get(0);
        info!(id, "pdf stored in database");
        let pid = pipeline_id
            .as_deref()
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
            .unwrap_or_else(|| uuid::Uuid::nil());
        db
            .execute(
                "UPDATE uploads SET pdf_id=$1, pipeline_id=$2, status='ocr' WHERE id=$3",
                &[&id, &pid, &upload_id],
            )
            .await
            .ok();
        let names: Vec<String> = files.iter().map(|f| f.1.clone()).collect();
        let stmt = db
            .prepare("INSERT INTO pdf_sources (pdf_id, names, count) VALUES ($1,$2,$3)")
            .await
            .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
        let _ = db
            .execute(&stmt, &[&id, &serde_json::to_string(&names).unwrap(), &(names.len() as i32)])
            .await
            .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
        let payload = serde_json::to_string(&PdfUploaded {
            pdf_id: id,
            pipeline_id: pid,
        })
        .unwrap();
        let _ = producer
            .send(
                FutureRecord::to("pdf-merged").payload(&payload).key(&()),
                Duration::from_secs(0),
            )
            .await;
        info!(id, "published pdf-merged event");
        return Ok(HttpResponse::Ok().json(UploadResponse { id: id.to_string() }));
    }
    Ok(HttpResponse::BadRequest().finish())
}

async fn list_uploads(
    db: web::Data<tokio_postgres::Client>,
) -> Result<HttpResponse, Error> {
    let stmt = db
        .prepare("SELECT id, pdf_id, pipeline_id, status FROM uploads ORDER BY id DESC")
        .await
        .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
    let rows = db
        .query(&stmt, &[])
        .await
        .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
    let items: Vec<UploadEntry> = rows
        .into_iter()
        .map(|r| UploadEntry {
            id: r.get(0),
            pdf_id: r.get(1),
            status: r.get(3),
        })
        .collect();
    Ok(HttpResponse::Ok().json(items))
}

async fn get_pdf(
    id: web::Path<i32>,
    db: web::Data<tokio_postgres::Client>,
) -> Result<HttpResponse, Error> {
    let stmt = db
        .prepare("SELECT data FROM pdfs WHERE id=$1")
        .await
        .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
    match db.query_opt(&stmt, &[&id.into_inner()]).await {
        Ok(Some(row)) => {
            let data: Vec<u8> = row.get(0);
            Ok(HttpResponse::Ok()
                .insert_header((header::CONTENT_TYPE, "application/pdf"))
                .body(data))
        }
        Ok(None) => Ok(HttpResponse::NotFound().finish()),
        Err(e) => Err(actix_web::error::ErrorInternalServerError(e)),
    }
}

async fn delete_pdf(
    id: web::Path<i32>,
    db: web::Data<tokio_postgres::Client>,
) -> Result<HttpResponse, Error> {
    let stmt = db
        .prepare("DELETE FROM pdfs WHERE id=$1")
        .await
        .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
    let rows = db
        .execute(&stmt, &[&id.into_inner()])
        .await
        .map_err(|e| actix_web::error::ErrorInternalServerError(e))?;
    if rows == 0 {
        Ok(HttpResponse::NotFound().finish())
    } else {
        Ok(HttpResponse::Ok().finish())
    }
}

async fn health() -> impl Responder {
    "OK"
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting pdf-ingest service");
    let settings = Settings::new().unwrap();
    let tls_connector = TlsConnector::builder().build().unwrap();
    let connector = MakeTlsConnector::new(tls_connector);
    let (db_client, connection) =
        tokio_postgres::connect(&settings.database_url, connector)
            .await
            .unwrap();
    let db_client = web::Data::new(db_client);
    info!("connected to database");
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("db error: {e}")
        }
    });
    db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS pdfs (id SERIAL PRIMARY KEY, data BYTEA NOT NULL)",
            &[],
        )
        .await
        .unwrap();
    info!("ensured pdfs table exists");
    db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS pdf_sources (pdf_id INTEGER PRIMARY KEY REFERENCES pdfs(id), names TEXT, count INTEGER)",
            &[],
        )
        .await
        .unwrap();
    info!("ensured pdf_sources table exists");
    db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS uploads (id SERIAL PRIMARY KEY, pdf_id INTEGER, pipeline_id UUID, status TEXT NOT NULL)",
            &[],
        )
        .await
        .unwrap();
    info!("ensured uploads table exists");
    let producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &settings.message_broker_url)
        .create()
        .unwrap();
    info!("kafka producer created");
    let db = db_client.clone();
    HttpServer::new(move || {
        App::new()
            .wrap(Cors::permissive())
            .app_data(db.clone())
            .app_data(web::Data::new(producer.clone()))
            .route("/upload", web::post().to(upload))
            .route("/uploads", web::get().to(list_uploads))
            .route("/pdf/{id}", web::get().to(get_pdf))
            .route("/pdf/{id}", web::delete().to(delete_pdf))
            .route("/health", web::get().to(health))
    })
    .bind(("0.0.0.0", 8081))?
    .run()
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, web, App};

    #[actix_web::test]
    async fn health_ok() {
        let app = test::init_service(App::new().route("/health", web::get().to(health))).await;
        let req = test::TestRequest::get().uri("/health").to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());
    }

    #[actix_web::test]
    async fn get_pdf_ok() {
        let url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://postgres:postgres@localhost/postgres".into());
        let tls_connector = TlsConnector::builder().build().unwrap();
        let connector = MakeTlsConnector::new(tls_connector);
        if let Ok((client, connection)) = tokio_postgres::connect(&url, connector).await {
            tokio::spawn(async move {
                let _ = connection.await;
            });
            client
                .execute(
                    "CREATE TABLE IF NOT EXISTS pdfs (id SERIAL PRIMARY KEY, data BYTEA NOT NULL)",
                    &[],
                )
                .await
                .unwrap();
            client
                .execute(
                    "CREATE TABLE IF NOT EXISTS pdf_sources (pdf_id INTEGER PRIMARY KEY REFERENCES pdfs(id), names TEXT, count INTEGER)",
                    &[],
                )
                .await
                .unwrap();
            client
                .execute(
                    "CREATE TABLE IF NOT EXISTS uploads (id SERIAL PRIMARY KEY, pdf_id INTEGER, pipeline_id UUID, status TEXT NOT NULL)",
                    &[],
                )
                .await
                .unwrap();
            client
                .execute(
                    "INSERT INTO pdfs (data) VALUES ($1)",
                    &[&b"test".as_slice()],
                )
                .await
                .unwrap();
            let app = test::init_service(
                App::new()
                    .app_data(web::Data::new(client))
                    .route("/pdf/{id}", web::get().to(get_pdf))
                    .route("/pdf/{id}", web::delete().to(delete_pdf)),
            )
            .await;
            let req = test::TestRequest::get().uri("/pdf/1").to_request();
            let resp = test::call_and_read_body(&app, req).await;
            assert_eq!(&resp[..], b"test");

            let req = test::TestRequest::delete().uri("/pdf/1").to_request();
            let resp = test::call_service(&app, req).await;
            assert!(resp.status().is_success());
        }
    }
}
