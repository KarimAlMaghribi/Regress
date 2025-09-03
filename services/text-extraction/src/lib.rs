use anyhow::{anyhow, Context, Result};
use tokio::process::Command;
use tracing::info;

/// Extract text from a PDF by invoking the external `pdftotext` command.
/// The command must be available in `$PATH`.
pub async fn extract_text(path: &str) -> Result<String> {
    info!(
        step = "extract.start",
        ?path,
        "starting text extraction via pdftotext"
    );
    let mut cmd = Command::new("pdftotext");
    // Standard: Layout behalten; mit PDFTEXT_LAYOUT=0 deaktivierbar
    let use_layout = std::env::var("PDFTEXT_LAYOUT")
        .map(|v| v != "0")
        .unwrap_or(true);
    if use_layout {
        cmd.arg("-layout");
    }
    cmd.arg("-q").arg(path).arg("-");
    let output = cmd.output().await.context("spawn pdftotext")?;
    if !output.status.success() {
        return Err(anyhow!("pdftotext exit status: {}", output.status));
    }
    let text = String::from_utf8(output.stdout).context("invalid utf8 from pdftotext")?;
    info!(
        step = "extract.finish",
        ?path,
        len = text.len(),
        "text extracted"
    );
    Ok(text)
}
