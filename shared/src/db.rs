use anyhow::{Context, Result};
use tokio_postgres::Client;
use uuid::Uuid;
use serde_json::Value;
use sqlx::{PgPool};
use sqlx::types::Json;

/// Fetch raw PDF bytes from the `merged_pdfs` table.
///
/// Returns the PDF data for the given `id` or an error if the row is missing.
pub async fn fetch_pdf(db: &Client, id: i32) -> Result<Vec<u8>> {
    let stmt = db
        .prepare("SELECT data FROM merged_pdfs WHERE id = $1")
        .await
        .context("prepare fetch_pdf")?;
    let row = db
        .query_one(&stmt, &[&id])
        .await
        .context("query fetch_pdf")?;
    Ok(row.get(0))
}

/// Mandant anlegen (idempotent per UNIQUE name).
pub async fn create_tenant(pool: &PgPool, req: &CreateTenantRequest) -> sqlx::Result<Tenant> {
    let rec = sqlx::query!(
        r#"INSERT INTO tenants (name) VALUES ($1)
           ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id, name"#,
        req.name
    )
        .fetch_one(pool)
        .await?;

    Ok(Tenant { id: rec.id, name: rec.name })
}

/// Alle Mandanten alphabetisch.
pub async fn list_tenants(pool: &PgPool) -> sqlx::Result<Vec<Tenant>> {
    let rows = sqlx::query!(r#"SELECT id, name FROM tenants ORDER BY name ASC"#)
        .fetch_all(pool)
        .await?;

    Ok(rows.into_iter().map(|r| Tenant { id: r.id, name: r.name }).collect())
}

/// Analysen (pipeline_runs) als JSON-Zeilen aus View v_pipeline_runs_with_tenant,
/// optional gefiltert nach tenant_name (ILIKE).
pub async fn list_analyses_with_tenant_json(
    pool: &PgPool,
    tenant_like: Option<String>,
    status: Option<String>,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<Value>> {
    let rows = sqlx::query_as::<_, (Json<Value>,)>(
        r#"
        SELECT to_jsonb(v.*) AS data
          FROM v_pipeline_runs_with_tenant v
         WHERE ($1::text IS NULL OR v.tenant_name ILIKE '%' || $1 || '%')
           AND ($2::text IS NULL OR v.status = $2)
         ORDER BY v.created_at DESC
         LIMIT $3 OFFSET $4
        "#
    )
        .bind(tenant_like)
        .bind(status)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?;

    Ok(rows.into_iter().map(|(Json(v),)| v).collect())
}

/// History (analysis_history) als JSON-Zeilen aus View v_analysis_history_with_tenant,
/// optional gefiltert nach tenant_name (ILIKE).
pub async fn list_history_with_tenant_json(
    pool: &PgPool,
    tenant_like: Option<String>,
    status: Option<String>,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Vec<Value>> {
    let rows = sqlx::query_as::<_, (Json<Value>,)>(
        r#"
        SELECT to_jsonb(v.*) AS data
          FROM v_analysis_history_with_tenant v
         WHERE ($1::text IS NULL OR v.tenant_name ILIKE '%' || $1 || '%')
           AND ($2::text IS NULL OR v.status = $2)
         ORDER BY "timestamp" DESC NULLS LAST
         LIMIT $3 OFFSET $4
        "#
    )
        .bind(tenant_like)
        .bind(status)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?;

    Ok(rows.into_iter().map(|(Json(v),)| v).collect())
}