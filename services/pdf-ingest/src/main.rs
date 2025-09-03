use actix_cors::Cors;
use actix_multipart::Multipart;
use actix_web::http::header;
use actix_web::web::Bytes;
use actix_web::{web, App, Error, HttpResponse, HttpServer, Responder};
use futures_util::StreamExt as _;
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::ClientConfig;
use sha2::{Digest, Sha256};
use shared::config::Settings;
use shared::dto::{PdfUploaded, UploadResponse};
use std::collections::BTreeMap;
use std::time::Duration;
use tracing::{error, info};
use uuid::Uuid;

use lopdf::{Bookmark, Document, Object, ObjectId};
use serde::Serialize;
use zip::ZipArchive;

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
                catalog_object = Some((
                    catalog_object.map(|c| c.0).unwrap_or(*object_id),
                    object.clone(),
                ));
            }
            b"Pages" => {
                if let Ok(dictionary) = object.as_dict() {
                    let mut dictionary = dictionary.clone();
                    if let Some((_, ref object)) = pages_object {
                        if let Ok(old_dictionary) = object.as_dict() {
                            dictionary.extend(old_dictionary);
                        }
                    }
                    pages_object = Some((
                        pages_object.map(|p| p.0).unwrap_or(*object_id),
                        Object::Dictionary(dictionary),
                    ));
                }
            }
            b"Page" | b"Outlines" | b"Outline" => {}
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

    // Upload-Row anlegen
    let upload_id: i32 = db
        .query_one(
            "INSERT INTO uploads (status) VALUES ('merging') RETURNING id",
            &[],
        )
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?
        .get(0);

    let mut files: Vec<(Vec<u8>, String)> = Vec::new();
    let mut pipeline_id: Option<String> = None;

    while let Some(item) = payload.next().await {
        let mut field = item?;
        match field.name() {
            "file" => {
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
            }
            "pipeline_id" => {
                while let Some(chunk) = field.next().await {
                    let bytes: Bytes = chunk?;
                    pipeline_id = Some(std::str::from_utf8(&bytes).unwrap_or_default().to_string());
                }
            }
            // Unbekannte Felder drainen
            _ => while let Some(_chunk) = field.next().await {},
        }
    }

    if files.is_empty() {
        return Ok(HttpResponse::BadRequest().finish());
    }

    // Merge oder einzelnes PDF
    let data = if files.len() == 1 {
        files[0].0.clone()
    } else {
        let mut docs = Vec::with_capacity(files.len());
        for (bytes, name) in &files {
            match Document::load_mem(bytes) {
                Ok(doc) => docs.push(doc),
                Err(e) => {
                    return Err(actix_web::error::ErrorBadRequest(format!(
                        "invalid PDF '{}': {e}",
                        name
                    )));
                }
            }
        }
        merge_documents(docs).map_err(actix_web::error::ErrorInternalServerError)?
    };

    info!(bytes = data.len(), "storing pdf");
    info!(step = "pdf.prepare", bytes = data.len(), "ready to insert");
    let sha256 = format!("{:x}", Sha256::digest(&data));
    let size_bytes = data.len() as i32;
    let id: i32 = db
        .query_one(
            "INSERT INTO merged_pdfs (data, sha256, size_bytes) VALUES ($1,$2,$3) RETURNING id",
            &[&data, &sha256, &size_bytes],
        )
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?
        .get(0);
    info!(id, "pdf stored in database");
    info!(step = "db.insert.ok", table = "merged_pdfs", id, sha256 = %sha256, size_bytes, "inserted merged pdf");

    // Upload-Row updaten
    let pid = pipeline_id
        .as_deref()
        .and_then(|s| Uuid::parse_str(s).ok())
        .unwrap_or_else(Uuid::nil);

    let _ = db
        .execute(
            "UPDATE uploads SET pdf_id=$1, pipeline_id=$2, status='ocr' WHERE id=$3",
            &[&id, &pid, &upload_id],
        )
        .await;

    info!(step = "uploads.updated", upload_id, pdf_id = id, status = "ocr", pipeline_id = %pid, "upload updated");

    // Quellen speichern (Dateinamen)
    let names: Vec<String> = files.iter().map(|f| f.1.clone()).collect();
    let _ = db
        .execute(
            "INSERT INTO pdf_sources (pdf_id, names, count) VALUES ($1,$2,$3)
             ON CONFLICT (pdf_id) DO UPDATE SET names=EXCLUDED.names, count=EXCLUDED.count",
            &[
                &id,
                &serde_json::to_string(&names).unwrap(),
                &(names.len() as i32),
            ],
        )
        .await;

    info!(
        step = "pdf_sources.upserted",
        pdf_id = id,
        count = names.len(),
        "source names upserted"
    );

    // Kafka-Event
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

    info!(
        step = "kafka.produce.ok",
        topic = "pdf-merged",
        key = upload_id,
        pdf_id = id
    );
    info!(id, "published pdf-merged event");

    Ok(HttpResponse::Ok().json(UploadResponse { id: id.to_string() }))
}

async fn list_uploads(db: web::Data<tokio_postgres::Client>) -> Result<HttpResponse, Error> {
    let rows = db
        .query(
            "SELECT id, pdf_id, status FROM uploads ORDER BY id DESC",
            &[],
        )
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    let items: Vec<UploadEntry> = rows
        .into_iter()
        .map(|r| UploadEntry {
            id: r.get(0),
            pdf_id: r.get(1),
            status: r.get(2),
        })
        .collect();

    Ok(HttpResponse::Ok().json(items))
}

async fn get_pdf(
    id: web::Path<i32>,
    db: web::Data<tokio_postgres::Client>,
) -> Result<HttpResponse, Error> {
    let stmt = db
        .prepare("SELECT data FROM merged_pdfs WHERE id=$1")
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
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

async fn get_extract(
    id: web::Path<i32>,
    db: web::Data<tokio_postgres::Client>,
) -> Result<HttpResponse, Error> {
    let stmt = db
        .prepare(
            // Alle Seiten in stabiler Reihenfolge zusammenführen
            "SELECT COALESCE(
                 string_agg(text, E'\n' ORDER BY page_no),
                 ''
             ) FROM pdf_texts WHERE merged_pdf_id = $1",
        )
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;
    match db.query_opt(&stmt, &[&id.into_inner()]).await {
        Ok(Some(row)) => {
            let text: String = row.get(0);
            Ok(HttpResponse::Ok()
                .insert_header((header::CONTENT_TYPE, "text/plain"))
                .body(text))
        }
        Ok(None) => Ok(HttpResponse::NotFound().finish()),
        Err(e) => Err(actix_web::error::ErrorInternalServerError(e)),
    }
}

async fn delete_pdf(
    id: web::Path<i32>,
    db: web::Data<tokio_postgres::Client>,
) -> Result<HttpResponse, Error> {
    let id = id.into_inner();

    // Abhängigkeiten aufräumen (dürfen fehlen)
    let _ = db
        .execute("DELETE FROM pdf_sources WHERE pdf_id=$1", &[&id])
        .await;
    let _ = db
        .execute("DELETE FROM pdf_texts  WHERE merged_pdf_id=$1", &[&id])
        .await;

    let rows = db
        .execute("DELETE FROM merged_pdfs WHERE id=$1", &[&id])
        .await
        .map_err(actix_web::error::ErrorInternalServerError)?;

    if rows == 0 {
        Ok(HttpResponse::NotFound().finish())
    } else {
        Ok(HttpResponse::Ok().finish())
    }
}

async fn health() -> impl Responder {
    "OK"
}

mod db_connect {
    use tokio::time::{sleep, Duration};
    use tokio_postgres::{Client, NoTls};
    use tracing::{error, info, warn};

    fn parse_host_port(url: &str) -> (Option<String>, Option<u16>) {
        if let Some(after_scheme) = url.splitn(2, "://").nth(1) {
            let after_at = after_scheme.splitn(2, '@').last().unwrap_or(after_scheme);
            let host_port = after_at.splitn(2, '/').next().unwrap_or(after_at);
            let mut it = host_port.splitn(2, ':');
            let host = it.next().map(|s| s.to_string());
            let port = it.next().and_then(|p| p.parse::<u16>().ok());
            (host, port)
        } else {
            (None, None)
        }
    }

    fn want_tls(database_url: &str) -> bool {
        let Some(qs) = database_url.splitn(2, '?').nth(1) else {
            return true;
        };
        for pair in qs.split('&') {
            let mut it = pair.splitn(2, '=');
            let k = it.next().unwrap_or("");
            let v = it.next().unwrap_or("");
            if k.eq_ignore_ascii_case("sslmode") {
                return !v.eq_ignore_ascii_case("disable");
            }
        }
        true
    }

    pub async fn connect_with_retry(database_url: &str) -> Client {
        let (host_opt, port_opt) = parse_host_port(database_url);
        if let Some(h) = host_opt.as_deref() {
            let p = port_opt.unwrap_or(5432);
            match tokio::net::lookup_host((h, p)).await {
                Ok(mut addrs) => {
                    if let Some(a) = addrs.next() {
                        info!("DB DNS ok: {} -> {}", h, a);
                    } else {
                        warn!("DB DNS: {} hat keine Adressen geliefert", h);
                    }
                }
                Err(e) => warn!("DB DNS-Auflösung fehlgeschlagen ({}:{}): {}", h, p, e),
            }
        }

        let mut backoff = 1u64;

        loop {
            if want_tls(database_url) {
                // Zuerst TLS probieren
                match native_tls::TlsConnector::builder().build() {
                    Ok(tls) => {
                        let tls = postgres_native_tls::MakeTlsConnector::new(tls);
                        match tokio_postgres::connect(database_url, tls).await {
                            Ok((client, connection)) => {
                                tokio::spawn(async move {
                                    if let Err(e) = connection.await {
                                        error!(%e, "postgres connection task ended with error (TLS)");
                                    }
                                });
                                info!("Connected to PostgreSQL (TLS).");
                                return client;
                            }
                            Err(e) => error!(%e, "DB connect (TLS) failed; will try NoTLS"),
                        }
                    }
                    Err(e) => warn!(%e, "building TLS connector failed; falling back to NoTLS"),
                }
            }

            // NoTLS (aktuelles Setup: sslmode=disable)
            match tokio_postgres::connect(database_url, NoTls).await {
                Ok((client, connection)) => {
                    tokio::spawn(async move {
                        if let Err(e) = connection.await {
                            error!(%e, "postgres connection task ended with error (NoTLS)");
                        }
                    });
                    info!("Connected to PostgreSQL (NoTLS).");
                    return client;
                }
                Err(e) => {
                    error!(%e, "DB connect (NoTLS) failed");
                    let wait = backoff.min(10);
                    sleep(Duration::from_secs(wait)).await;
                    backoff = (backoff + 1).min(10);
                }
            }
        }
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt::init();
    info!("starting pdf-ingest service");

    let settings = match Settings::new() {
        Ok(s) => s,
        Err(e) => {
            error!(%e, "failed to load settings");
            std::process::exit(1);
        }
    };

    let db_client = db_connect::connect_with_retry(&settings.database_url).await;
    info!("connected to database");

    if let Err(e) = db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS merged_pdfs (
                id SERIAL PRIMARY KEY,
                sha256 TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                data BYTEA NOT NULL
            )",
            &[],
        )
        .await
    {
        error!(%e, "failed to create merged_pdfs table");
    }

    if let Err(e) = db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS pdf_sources (
                pdf_id INTEGER PRIMARY KEY REFERENCES merged_pdfs(id),
                names TEXT,
                count INTEGER
            )",
            &[],
        )
        .await
    {
        error!(%e, "failed to create pdf_sources table");
    }

    if let Err(e) = db_client
        .execute(
            "CREATE TABLE IF NOT EXISTS uploads ( \
                id SERIAL PRIMARY KEY, \
                pdf_id INTEGER, \
                pipeline_id UUID, \
                status TEXT NOT NULL \
            )",
            &[],
        )
        .await
    {
        error!(%e, "failed to create uploads table");
    }

    // Kafka Producer
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
    info!("kafka producer created");

    let db = web::Data::new(db_client);
    let producer_data = web::Data::new(producer);

    HttpServer::new(move || {
        App::new()
            .wrap(Cors::permissive())
            .app_data(db.clone())
            .app_data(producer_data.clone())
            .route("/upload", web::post().to(upload))
            .route("/uploads", web::get().to(list_uploads))
            .route("/uploads/{id}/extract", web::get().to(get_extract))
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
    use actix_web::http::StatusCode;
    use actix_web::{test, web, App};
    use tokio_postgres::NoTls;

    #[actix_web::test]
    async fn health_ok() {
        let app =
            test::init_service(App::new().route("/health", web::get().to(super::health))).await;
        let req = test::TestRequest::get().uri("/health").to_request();
        let resp = test::call_service(&app, req).await;
        assert!(resp.status().is_success());
    }

    #[actix_web::test]
    async fn get_pdf_ok() {
        let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
            "postgres://postgres:postgres@localhost/postgres?sslmode=disable".into()
        });

        if let Ok((client, connection)) = tokio_postgres::connect(&url, NoTls).await {
            tokio::spawn(async move {
                let _ = connection.await;
            });

            let _ = client
                .execute(
                    "CREATE TABLE IF NOT EXISTS merged_pdfs (id SERIAL PRIMARY KEY, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, data BYTEA NOT NULL)",
                    &[],
                )
                .await;
            let _ = client
                .execute(
                    "CREATE TABLE IF NOT EXISTS pdf_sources (pdf_id INTEGER PRIMARY KEY REFERENCES merged_pdfs(id), names TEXT, count INTEGER)",
                    &[],
                )
                .await;

            let _ = client
                .execute(
                    "INSERT INTO merged_pdfs (data, sha256, size_bytes) VALUES ($1,$2,$3)",
                    &[&b"test".as_slice(), &"hash", &4],
                )
                .await;
            let _ = client
                .execute(
                    "INSERT INTO pdf_sources (pdf_id, names, count) VALUES ($1,$2,$3)
                     ON CONFLICT (pdf_id) DO NOTHING",
                    &[&1, &"[]", &0],
                )
                .await;

            let app = test::init_service(
                App::new()
                    .app_data(web::Data::new(client))
                    .route("/pdf/{id}", web::get().to(super::get_pdf))
                    .route("/pdf/{id}", web::delete().to(super::delete_pdf)),
            )
            .await;

            let req = test::TestRequest::get().uri("/pdf/1").to_request();
            let resp = test::call_and_read_body(&app, req).await;
            assert_eq!(&resp[..], b"test");

            let req = test::TestRequest::delete().uri("/pdf/1").to_request();
            let resp = test::call_service(&app, req).await;
            assert!(resp.status().is_success());

            let req = test::TestRequest::get().uri("/pdf/1").to_request();
            let resp = test::call_service(&app, req).await;
            assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        }
    }

    #[actix_web::test]
    async fn get_extract_ok() {
        let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
            "postgres://postgres:postgres@localhost/postgres?sslmode=disable".into()
        });

        if let Ok((client, connection)) = tokio_postgres::connect(&url, NoTls).await {
            tokio::spawn(async move {
                let _ = connection.await;
            });

            let _ = client
                .execute(
                    "CREATE TABLE IF NOT EXISTS pdf_texts ( 
                        merged_pdf_id INTEGER NOT NULL, 
                        page_no INTEGER NOT NULL, 
                        text TEXT NOT NULL, 
                        UNIQUE (merged_pdf_id, page_no) 
                    )",
                    &[],
                )
                .await;
            let _ = client
                .execute(
                    "INSERT INTO pdf_texts (merged_pdf_id, page_no, text) VALUES ($1,$2,$3)",
                    &[&1, &0, &"hello"],
                )
                .await;

            let app = test::init_service(
                App::new()
                    .app_data(web::Data::new(client))
                    .route("/uploads/{id}/extract", web::get().to(super::get_extract)),
            )
            .await;

            let req = test::TestRequest::get()
                .uri("/uploads/1/extract")
                .to_request();
            let resp = test::call_and_read_body(&app, req).await;
            assert_eq!(&resp[..], b"hello");
        }
    }
}
