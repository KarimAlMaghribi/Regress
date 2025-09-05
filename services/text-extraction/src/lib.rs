use anyhow::{anyhow, Context, Result};
use tokio::process::Command;
use tracing::info;

/// Gesamtextrakt via `pdftotext` (einmal für das ganze PDF).
/// Nutzt `-layout`, wenn `PDFTEXT_LAYOUT` nicht explizit auf "0" gesetzt ist.
pub async fn extract_text(path: &str) -> Result<String> {
    info!(
        step = "extract.start",
        ?path,
        "starting text extraction via pdftotext"
    );

    let mut cmd = Command::new("pdftotext");
    // Standard: Layout beibehalten; mit PDFTEXT_LAYOUT=0 deaktivierbar
    let use_layout = std::env::var("PDFTEXT_LAYOUT")
        .map(|v| v != "0")
        .unwrap_or(true);
    if use_layout {
        cmd.arg("-layout");
    }

    let output = cmd.arg("-q").arg(path).arg("-").output().await?;
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

/// Seitenweise Extraktion:
/// 1) `pdfinfo` ermittelt die Seitenzahl.
/// 2) Für jede Seite wird `pdftotext -f N -l N` aufgerufen.
/// 3) Rückgabe: Vec<(page_no, text)> mit 0-basierter Seitennummer.
pub async fn extract_text_pages(path: &str) -> Result<Vec<(i32, String)>> {
    // Seitenzahl bestimmen
    let info = Command::new("pdfinfo").arg(path).output().await;
    let pages: i32 = match info {
        Ok(out) if out.status.success() => {
            let s = String::from_utf8_lossy(&out.stdout);
            s.lines()
                .find(|l| l.trim_start().starts_with("Pages:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|n| n.parse::<i32>().ok())
                .unwrap_or(1)
        }
        _ => 1,
    };
    info!(pages, "detected pages");

    // Für jede Seite in UTF-8, UNIX-EOL
    let use_layout = std::env::var("PDFTEXT_LAYOUT")
        .map(|v| v != "0")
        .unwrap_or(true);

    let mut result = Vec::with_capacity(pages as usize);
    for p in 1..=pages {
        let mut cmd = Command::new("pdftotext");
        if use_layout {
            cmd.arg("-layout");
        }
        let out = cmd
            .arg("-q")
            .arg("-enc")
            .arg("UTF-8")
            .arg("-eol")
            .arg("unix")
            .arg("-f")
            .arg(p.to_string())
            .arg("-l")
            .arg(p.to_string())
            .arg(path)
            .arg("-")
            .output()
            .await
            .with_context(|| format!("spawn pdftotext page {p}"))?;

        if !out.status.success() {
            return Err(anyhow!(
                "pdftotext exit status on page {p}: {}",
                out.status
            ));
        }
        let txt = String::from_utf8(out.stdout).context("invalid utf8 from pdftotext")?;
        result.push((p - 1, txt));
    }

    if result.is_empty() {
        // Fallback: mindestens eine Seite liefern
        result.push((0, extract_text(path).await?));
    }
    Ok(result)
}
