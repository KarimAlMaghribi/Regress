//! Lightweight TCP scanner that discovers the SharePoint conversion worker.

use anyhow::{bail, Context, Result};
use std::{env, fs, io::Read, net::SocketAddr, path::Path};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

#[derive(Clone, Debug)]
pub struct ScanConfig {
    pub enabled: bool,
    pub clamd_addr: Option<SocketAddr>,
    pub max_upload_bytes: u64,
}

impl ScanConfig {
    /// Loads scan configuration flags and limits from environment variables.
    pub fn from_env() -> Self {
        let enabled = env::var("SCAN_ENABLED")
            .ok()
            .map(|v| v == "true")
            .unwrap_or(true);
        let host = env::var("CLAMD_HOST").ok();
        let port = env::var("CLAMD_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3310);
        let clamd_addr = host.and_then(|h| format!("{}:{}", h, port).parse().ok());
        let max_upload_mb = env::var("MAX_UPLOAD_MB")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(200u64);
        Self {
            enabled,
            clamd_addr,
            max_upload_bytes: max_upload_mb * 1024 * 1024,
        }
    }
}

/// Wirf Fehler, wenn Datei nicht valide PDF ist.
pub fn assert_pdf(path: &Path) -> Result<()> {
    if path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.eq_ignore_ascii_case("pdf"))
        != Some(true)
    {
        bail!("file extension not .pdf");
    }
    let mut f = fs::File::open(path).with_context(|| "open file")?;
    let mut head = [0u8; 5];
    let n = f.read(&mut head)?;
    if n < 5 || &head != b"%PDF-" {
        bail!("pdf magic header missing");
    }
    let mime = infer::get_from_path(path)
        .ok()
        .flatten()
        .map(|t| t.mime_type().to_string());
    if let Some(m) = mime {
        if m != "application/pdf" {
            bail!("mime sniff not pdf: {}", m);
        }
    }
    Ok(())
}

/// Wirf Fehler bei Fund. Gibt Ok(()) wenn sauber oder Scan deaktiviert.
pub async fn scan_with_clamd(path: &Path, cfg: &ScanConfig) -> Result<()> {
    if !cfg.enabled {
        return Ok(());
    }
    let Some(addr) = cfg.clamd_addr else {
        return Ok(());
    }; // Scanner optional
    let meta = fs::metadata(path)?;
    if meta.len() > cfg.max_upload_bytes {
        bail!("file too large for scan ({} bytes)", meta.len());
    }
    // clamd: INSTREAM
    let mut s = TcpStream::connect(addr)
        .await
        .with_context(|| "connect clamd")?;
    s.write_all(b"INSTREAM\n").await?;
    let mut f = tokio::fs::File::open(path).await?;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        let len_be = (n as u32).to_be_bytes();
        s.write_all(&len_be).await?;
        s.write_all(&buf[..n]).await?;
    }
    s.write_all(&0u32.to_be_bytes()).await?;
    // Antwort lesen
    let mut resp = Vec::new();
    s.read_to_end(&mut resp).await?;
    let text = String::from_utf8_lossy(&resp);
    // Beispiele: "stream: OK", "stream: Eicar-Test-Signature FOUND"
    if text.contains("FOUND") {
        bail!("clamav detected malware: {}", text.trim());
    }
    if !text.contains("OK") {
        bail!("clamav scan uncertain: {}", text.trim());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::assert_pdf;
    use std::io::Write;

    #[test]
    fn assert_pdf_accepts_valid_header() {
        let mut tmp = tempfile::Builder::new()
            .suffix(".pdf")
            .tempfile()
            .expect("temp pdf file");
        tmp.write_all(b"%PDF-1.7\n")
            .expect("write pdf header");
        assert_pdf(tmp.path()).expect("valid pdf should pass");
    }
}
