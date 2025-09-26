use anyhow::{Context, Result};
use serde_json::Value;
use tokio_postgres::{types::ToSql, Client};
use uuid::Uuid;

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

/// Create or upsert a tenant by name and return (id, name).
pub async fn create_tenant(db: &Client, name: &str) -> Result<(Uuid, String)> {
    let row = db.query_one(
        "INSERT INTO tenants (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name",
        &[&name],
    )
        .await
        .context("create_tenant")?;
    Ok((row.get(0), row.get(1)))
}

/// List tenants (id, name), ordered by name.
pub async fn list_tenants(db: &Client) -> Result<Vec<(Uuid, String)>> {
    let rows = db
        .query("SELECT id, name FROM tenants ORDER BY name ASC", &[])
        .await
        .context("list_tenants")?;
    Ok(rows.into_iter().map(|r| (r.get(0), r.get(1))).collect())
}

async fn query_json_vec(db: &Client, sql: &str, params: &[&(dyn ToSql + Sync)]) -> Result<Vec<Value>> {
    let rows = db.query(sql, params).await.context("db query_json_vec")?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let txt: String = row.get(0);
        let v: Value = serde_json::from_str(&txt).context("parse json from db")?;
        out.push(v);
    }
    Ok(out)
}

/// Query analyses from v_pipeline_runs_with_tenant with optional filters.
pub async fn list_analyses_with_tenant_json(
    db: &Client,
    tenant_like: Option<&str>,
    status: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<Value>> {
    query_json_vec(
        db,
        r#"
        SELECT (to_jsonb(v.*))::text AS data
          FROM v_pipeline_runs_with_tenant v
         WHERE ($1::text IS NULL OR v.tenant_name ILIKE '%' || $1 || '%')
           AND ($2::text IS NULL OR v.status = $2)
         ORDER BY v.created_at DESC
         LIMIT $3 OFFSET $4
        "#,
        &[&tenant_like, &status, &limit, &offset],
    )
        .await
}

/// Query history from v_analysis_history_with_tenant with optional filters.
pub async fn list_history_with_tenant_json(
    db: &Client,
    tenant_like: Option<&str>,
    status: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<Value>> {
    query_json_vec(
        db,
        r#"
        SELECT (to_jsonb(v.*))::text AS data
          FROM v_analysis_history_with_tenant v
         WHERE ($1::text IS NULL OR v.tenant_name ILIKE '%' || $1 || '%')
           AND ($2::text IS NULL OR v.status = $2)
         ORDER BY v."timestamp" DESC NULLS LAST
         LIMIT $3 OFFSET $4
        "#,
        &[&tenant_like, &status, &limit, &offset],
    )
        .await
}
