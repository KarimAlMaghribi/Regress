//! Microsoft Graph client wrappers used to download SharePoint content.

use std::{
    path::Path,
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};
use parking_lot::RwLock;
use rand::Rng;
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::{fs::File, io::AsyncWriteExt, time::sleep};
use tracing::warn;

use crate::config::Config;

const GRAPH_BASE: &str = "https://graph.microsoft.com/v1.0";
const MAX_RETRIES: u32 = 3;

pub struct MsGraphClient {
    http: Client,
    tenant_id: String,
    client_id: String,
    client_secret: String,
    site_host: String,
    site_path: String,
    site_id: RwLock<Option<String>>,
    drive_id: RwLock<Option<String>>,
    token: RwLock<Option<CachedToken>>,
}

#[derive(Clone, Debug)]
pub struct GraphFolder {
    pub id: String,
    pub name: String,
    pub file_count: i64,
}

#[derive(Clone, Debug)]
pub struct GraphFile {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct OAuthTokenResponse {
    token_type: String,
    expires_in: i64,
    access_token: String,
}

#[derive(Clone, Debug)]
struct CachedToken {
    token: String,
    expires_at: Instant,
}

#[derive(Debug, Deserialize)]
struct DriveItemResponse {
    value: Vec<DriveItem>,
}

#[derive(Debug, Deserialize)]
struct DriveItem {
    id: String,
    name: String,
    #[serde(default)]
    folder: Option<FolderFacet>,
    #[serde(default)]
    file: Option<FileFacet>,
}

#[derive(Debug, Deserialize)]
struct FolderFacet {
    #[serde(default)]
    child_count: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct FileFacet {
    #[serde(default)]
    mime_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SiteResponse {
    id: String,
}

#[derive(Debug, Deserialize)]
struct DriveResponse {
    id: String,
}

impl MsGraphClient {
    /// Creates a new Microsoft Graph client using the provided configuration
    /// values.
    pub fn new(config: &Config) -> Result<Self> {
        let http = Client::builder()
            .timeout(config.graph_timeout)
            .build()
            .context("building reqwest client")?;

        Ok(Self {
            http,
            tenant_id: config.tenant_id.clone(),
            client_id: config.client_id.clone(),
            client_secret: config.client_secret.clone(),
            site_host: config.site_host.clone(),
            site_path: config.site_path.clone(),
            site_id: RwLock::new(None),
            drive_id: RwLock::new(None),
            token: RwLock::new(None),
        })
    }

    /// Ensures the required base folder exists inside the SharePoint drive.
    pub async fn bootstrap(&self, config: &Config) -> Result<()> {
        self.ensure_site_and_drive().await?;
        self.ensure_folder(&config.drive_input_path()).await?;
        Ok(())
    }

    /// Lists the immediate subfolders below the provided base path.
    pub async fn list_subfolders(&self, base_path: &str) -> Result<Vec<GraphFolder>> {
        let drive_id = self.ensure_site_and_drive().await?;
        let path = encode_path(base_path);
        let url =
            format!("{GRAPH_BASE}/drives/{drive_id}/root:/{path}:/children?$select=id,name,folder");
        let resp = self
            .send_with_retry(self.authorized_request(Method::GET, url).await?)
            .await?;

        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }

        let body: DriveItemResponse = resp.json().await?;
        let folders = body
            .value
            .into_iter()
            .filter(|item| item.folder.is_some())
            .map(|item| GraphFolder {
                id: item.id,
                name: item.name,
                file_count: item.folder.and_then(|f| f.child_count).unwrap_or_default(),
            })
            .collect();

        Ok(folders)
    }

    /// Returns the PDF files contained in the specified SharePoint folder.
    pub async fn list_pdfs_in_folder(&self, folder_id: &str) -> Result<Vec<GraphFile>> {
        let drive_id = self.ensure_site_and_drive().await?;
        let url = format!(
            "{GRAPH_BASE}/drives/{drive_id}/items/{folder_id}/children?$select=id,name,size,file"
        );
        let resp = self
            .send_with_retry(self.authorized_request(Method::GET, url).await?)
            .await?;

        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }

        let body: DriveItemResponse = resp.json().await?;
        let files = body
            .value
            .into_iter()
            .filter(|item| {
                item.file
                    .as_ref()
                    .and_then(|f| f.mime_type.clone())
                    .map(|mt| mt.eq_ignore_ascii_case("application/pdf"))
                    .unwrap_or_else(|| item.name.to_ascii_lowercase().ends_with(".pdf"))
            })
            .map(|item| GraphFile {
                id: item.id,
                name: item.name,
            })
            .collect();
        Ok(files)
    }

    /// Downloads the file with the given identifier into the destination path.
    pub async fn download_file(&self, file_id: &str, dest: &Path) -> Result<()> {
        let drive_id = self.ensure_site_and_drive().await?;
        let url = format!("{GRAPH_BASE}/drives/{drive_id}/items/{file_id}/content");
        let mut resp = self
            .send_with_retry(self.authorized_request(Method::GET, url).await?)
            .await?
            .error_for_status()?;
        let mut file = File::create(dest).await?;
        while let Some(chunk) = resp.chunk().await? {
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        Ok(())
    }

    /// Ensures the provided drive path exists by creating the folder hierarchy
    /// if it is missing.
    pub async fn ensure_folder(&self, drive_path: &str) -> Result<()> {
        let drive_id = self.ensure_site_and_drive().await?;
        let path = encode_path(drive_path);
        let get_url = format!("{GRAPH_BASE}/drives/{drive_id}/root:/{path}");
        let resp = self
            .send_with_retry(self.authorized_request(Method::GET, get_url).await?)
            .await?;

        if resp.status() == StatusCode::NOT_FOUND {
            let segments: Vec<&str> = drive_path.split('/').collect();
            let mut current = String::new();
            for segment in segments {
                if !current.is_empty() {
                    current.push('/');
                }
                current.push_str(segment);
                let segment_path = encode_path(&current);
                let check_url = format!("{GRAPH_BASE}/drives/{drive_id}/root:/{segment_path}");
                let check = self
                    .send_with_retry(
                        self.authorized_request(Method::GET, check_url.clone())
                            .await?,
                    )
                    .await?;
                if check.status() == StatusCode::NOT_FOUND {
                    let parent = current
                        .rsplit_once('/')
                        .map(|(head, _)| head.to_string())
                        .unwrap_or_else(|| String::new());
                    let create_url = if parent.is_empty() {
                        format!("{GRAPH_BASE}/drives/{drive_id}/root/children")
                    } else {
                        format!(
                            "{GRAPH_BASE}/drives/{drive_id}/root:/{}/children",
                            encode_path(&parent)
                        )
                    };
                    let name = segment.to_string();
                    let resp = self
                        .send_with_retry(
                            self.authorized_request(Method::POST, create_url)
                                .await?
                                .json(&serde_json::json!({
                                    "name": name,
                                    "folder": serde_json::json!({}),
                                    "@microsoft.graph.conflictBehavior": "fail"
                                })),
                        )
                        .await?;

                    if resp.status() == StatusCode::CONFLICT {
                        continue;
                    }

                    resp.error_for_status()?;
                }
            }
        }
        Ok(())
    }

    async fn ensure_site_and_drive(&self) -> Result<String> {
        if let Some(drive_id) = self.drive_id.read().clone() {
            return Ok(drive_id);
        }

        let cached_site = { self.site_id.read().clone() };
        let site_id = if let Some(site_id) = cached_site {
            site_id
        } else {
            let fetched = self.fetch_site_id().await?;
            {
                let mut guard = self.site_id.write();
                *guard = Some(fetched.clone());
            }
            fetched
        };

        let drive_id = self.fetch_drive_id(&site_id).await?;
        {
            let mut guard = self.drive_id.write();
            *guard = Some(drive_id.clone());
        }
        Ok(drive_id)
    }

    async fn fetch_site_id(&self) -> Result<String> {
        let url = format!("{GRAPH_BASE}/sites/{}:{}", self.site_host, self.site_path);
        let resp = self
            .send_with_retry(self.authorized_request(Method::GET, url).await?)
            .await?
            .error_for_status()?;
        let site: SiteResponse = resp.json().await?;
        Ok(site.id)
    }

    async fn fetch_drive_id(&self, site_id: &str) -> Result<String> {
        let url = format!("{GRAPH_BASE}/sites/{site_id}/drive");
        let resp = self
            .send_with_retry(self.authorized_request(Method::GET, url).await?)
            .await?
            .error_for_status()?;
        let drive: DriveResponse = resp.json().await?;
        Ok(drive.id)
    }

    async fn authorized_request(&self, method: Method, url: String) -> Result<RequestBuilder> {
        let token = self.access_token().await?;
        Ok(self.http.request(method, url).bearer_auth(token))
    }

    async fn send_with_retry(&self, builder: RequestBuilder) -> Result<Response> {
        let request = builder
            .build()
            .map_err(|err| anyhow!("failed to build request: {err}"))?;
        let mut attempt = 0u32;
        loop {
            let req = request
                .try_clone()
                .ok_or_else(|| anyhow!("request body is not clonable"))?;
            match self.http.execute(req).await {
                Ok(response) => {
                    if should_retry(response.status()) && attempt < MAX_RETRIES {
                        let delay = backoff_with_jitter(attempt);
                        sleep(delay).await;
                        attempt += 1;
                        continue;
                    }
                    return Ok(response);
                }
                Err(err) => {
                    if attempt >= MAX_RETRIES {
                        return Err(err.into());
                    }
                    let delay = backoff_with_jitter(attempt);
                    sleep(delay).await;
                    attempt += 1;
                }
            }
        }
    }

    async fn access_token(&self) -> Result<String> {
        if let Some(token) = self.valid_cached_token() {
            return Ok(token);
        }
        self.fetch_token().await
    }

    fn valid_cached_token(&self) -> Option<String> {
        self.token.read().as_ref().and_then(|token| {
            if token.expires_at > Instant::now() - Duration::from_secs(60) {
                Some(token.token.clone())
            } else {
                None
            }
        })
    }

    async fn fetch_token(&self) -> Result<String> {
        let url = format!(
            "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
            self.tenant_id
        );
        let params = [
            ("client_id", self.client_id.as_str()),
            ("client_secret", self.client_secret.as_str()),
            ("scope", "https://graph.microsoft.com/.default"),
            ("grant_type", "client_credentials"),
        ];
        let resp = Client::new()
            .post(url)
            .form(&params)
            .send()
            .await?
            .error_for_status()?;
        let token: OAuthTokenResponse = resp.json().await?;
        let expires_at = Instant::now() + Duration::from_secs(token.expires_in as u64);
        let cached = CachedToken {
            token: token.access_token.clone(),
            expires_at,
        };
        {
            let mut guard = self.token.write();
            *guard = Some(cached);
        }
        Ok(token.access_token)
    }
}

fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|segment| urlencoding::encode(segment).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn should_retry(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn backoff_with_jitter(attempt: u32) -> Duration {
    let base = 200u64 * 2u64.pow(attempt.min(6));
    let jitter: u64 = rand::thread_rng().gen_range(0..100);
    Duration::from_millis(base + jitter)
}
