use std::{env, time::Duration};

use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct Config {
    pub tenant_id: String,
    pub client_id: String,
    pub client_secret: String,
    pub site_host: String,
    pub site_path: String,
    pub input_folder: String,
    pub processed_folder: String,
    pub failed_folder: String,
    pub upload_url: String,
    pub upload_api_token: Option<String>,
    pub admin_token: Option<String>,
    pub cors_origins: Option<Vec<String>>,
    pub max_concurrency: usize,
    pub http_bind: String,
    pub http_port: u16,
    pub graph_timeout: Duration,
    pub upload_timeout: Duration,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let tenant_id = env::var("TENANT_ID").context("TENANT_ID missing")?;
        let client_id = env::var("CLIENT_ID").context("CLIENT_ID missing")?;
        let client_secret = env::var("CLIENT_SECRET").context("CLIENT_SECRET missing")?;
        let site_host =
            env::var("SITE_HOST").unwrap_or_else(|_| "o365adessogroup.sharepoint.com".to_string());
        let site_path =
            env::var("SITE_PATH").unwrap_or_else(|_| "/sites/Regress-Allianz".to_string());
        let input_folder = env::var("INPUT_FOLDER").unwrap_or_else(|_| "Input".to_string());
        let processed_folder =
            env::var("PROCESSED_FOLDER").unwrap_or_else(|_| "Processed".to_string());
        let failed_folder = env::var("FAILED_FOLDER").unwrap_or_else(|_| "Failed".to_string());
        let upload_url = env::var("UPLOAD_URL").context("UPLOAD_URL missing")?;
        let upload_api_token = env::var("UPLOAD_API_TOKEN").ok();
        let admin_token = env::var("ADMIN_TOKEN").ok();
        let cors_origins = env::var("CORS_ORIGINS").ok().map(|origins| {
            origins
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        });
        let max_concurrency = env::var("MAX_CONCURRENCY")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(4);
        let http_bind = env::var("HTTP_BIND").unwrap_or_else(|_| "0.0.0.0".to_string());
        let http_port = env::var("INGRESS_PORT")
            .or_else(|_| env::var("PORT"))
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(8080);
        let graph_timeout = Duration::from_secs(
            env::var("GRAPH_TIMEOUT_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(120),
        );
        let upload_timeout = Duration::from_secs(
            env::var("UPLOAD_TIMEOUT_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(300),
        );

        Ok(Self {
            tenant_id,
            client_id,
            client_secret,
            site_host,
            site_path,
            input_folder,
            processed_folder,
            failed_folder,
            upload_url,
            upload_api_token,
            admin_token,
            cors_origins,
            max_concurrency,
            http_bind,
            http_port,
            graph_timeout,
            upload_timeout,
        })
    }

    pub fn drive_input_path(&self) -> String {
        self.input_folder.clone()
    }

    pub fn drive_processed_path(&self) -> String {
        self.processed_folder.clone()
    }

    pub fn drive_failed_path(&self) -> String {
        self.failed_folder.clone()
    }
}
