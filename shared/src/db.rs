use anyhow::{Context, Result};
use tokio_postgres::Client;

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
