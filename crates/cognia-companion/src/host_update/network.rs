//! The update Worker, as a host talks to it.
//!
//! Three requests: the signed catalog for a channel, the live rollout answer
//! for this host, and an archive download. Nothing fetched here is trusted:
//! the catalog is verified against the root the host ships with, the rollout
//! answer only counts when it matches the verified catalog, and an archive is
//! checked against the catalog's sha256 before it is unpacked.

use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt as _;
use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt as _;

/// The Worker the app also uses (`DEFAULT_CATALOG_URL` in `lib/updates/catalog-client.ts`).
pub const DEFAULT_UPDATE_URL: &str = "https://update.cognia.cn";
/// Largest catalog a host accepts.
const MAX_CATALOG_BYTES: usize = 8 * 1024 * 1024;
/// Largest archive a host downloads when the catalog names no size.
pub const MAX_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024;

/// One host's rollout question.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RolloutQuery {
    /// `darwin-arm64` → target `darwin`, arch `arm64` (split at the last hyphen).
    pub target: String,
    pub current_version: String,
    pub channel: String,
    pub bucket: u32,
    pub manual: bool,
}

/// What the Worker says is rolling for this host.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RolloutAnswer {
    pub version: String,
    #[serde(default)]
    pub digest: Option<String>,
}

#[async_trait]
pub trait UpdateNetwork: Send + Sync {
    /// The signed bundle for `channel`; `None` when none is published.
    async fn catalog(&self, channel: &str) -> Result<Option<Value>, String>;
    /// The release rolling for this host now; `None` when nothing is.
    async fn rollout(&self, query: &RolloutQuery) -> Result<Option<RolloutAnswer>, String>;
    /// Stream `url` into `destination`, refusing more than `max_bytes`.
    async fn download(&self, url: &str, destination: &Path, max_bytes: u64) -> Result<(), String>;
}

/// The real Worker, through the proxy-aware client every Rust egress uses.
pub struct HttpUpdateNetwork {
    base_url: String,
}

impl HttpUpdateNetwork {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_owned(),
        }
    }

    fn client(&self, url: &str, timeout: Duration) -> Result<reqwest::Client, String> {
        cognia_net::proxy_config::managed_client(
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(timeout),
            url,
        )
        .map_err(|error| error.to_string())
    }
}

/// `target-arch` split where the Worker keys its rows.
pub fn split_target(target: &str) -> Option<(&str, &str)> {
    let cut = target.rfind('-')?;
    let (target, arch) = (&target[..cut], &target[cut + 1..]);
    (!target.is_empty() && !arch.is_empty()).then_some((target, arch))
}

fn encode(segment: &str) -> String {
    url::form_urlencoded::byte_serialize(segment.as_bytes()).collect()
}

#[async_trait]
impl UpdateNetwork for HttpUpdateNetwork {
    async fn catalog(&self, channel: &str) -> Result<Option<Value>, String> {
        let url = format!("{}/v1/catalog?channel={}", self.base_url, encode(channel));
        let response = self
            .client(&url, Duration::from_secs(30))?
            .get(&url)
            .send()
            .await
            .map_err(|error| format!("catalog: {error}"))?;
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!(
                "catalog: the update service answered {}",
                response.status()
            ));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("catalog: {error}"))?;
        if bytes.len() > MAX_CATALOG_BYTES {
            return Err("catalog: larger than any catalog should be".into());
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("catalog: {error}"))
    }

    async fn rollout(&self, query: &RolloutQuery) -> Result<Option<RolloutAnswer>, String> {
        let (target, arch) = split_target(&query.target)
            .ok_or_else(|| format!("rollout: {} has no architecture", query.target))?;
        let url = format!(
            "{}/v1/rollout/host-server/host/{}/{}/{}?channel={}&bucket={}{}",
            self.base_url,
            encode(target),
            encode(arch),
            encode(&query.current_version),
            encode(&query.channel),
            query.bucket,
            if query.manual { "&manual=1" } else { "" }
        );
        let response = self
            .client(&url, Duration::from_secs(30))?
            .get(&url)
            .send()
            .await
            .map_err(|error| format!("rollout: {error}"))?;
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!(
                "rollout: the update service answered {}",
                response.status()
            ));
        }
        response
            .json()
            .await
            .map(Some)
            .map_err(|error| format!("rollout: {error}"))
    }

    async fn download(&self, url: &str, destination: &Path, max_bytes: u64) -> Result<(), String> {
        if !url.starts_with("https://") {
            return Err("download: only https archives are fetched".into());
        }
        let response = self
            .client(url, Duration::from_secs(30 * 60))?
            .get(url)
            .send()
            .await
            .map_err(|error| format!("download: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("download: {} answered {}", url, response.status()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes)
        {
            return Err("download: the archive is larger than the catalog says".into());
        }
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("download: {error}"))?;
        }
        let mut file = tokio::fs::File::create(destination)
            .await
            .map_err(|error| format!("download: {error}"))?;
        let mut written: u64 = 0;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("download: {error}"))?;
            written = written.saturating_add(chunk.len() as u64);
            if written > max_bytes {
                drop(file);
                let _ = tokio::fs::remove_file(destination).await;
                return Err("download: the archive is larger than the catalog says".into());
            }
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("download: {error}"))?;
        }
        file.flush()
            .await
            .map_err(|error| format!("download: {error}"))?;
        file.sync_all()
            .await
            .map_err(|error| format!("download: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_target_splits_where_the_worker_keys_it() {
        assert_eq!(split_target("darwin-arm64"), Some(("darwin", "arm64")));
        assert_eq!(split_target("oci-full-amd64"), Some(("oci-full", "amd64")));
        assert_eq!(split_target("darwin"), None);
        assert_eq!(split_target("-arm64"), None);
    }

    #[tokio::test]
    async fn only_https_archives_are_downloaded() {
        let tmp = tempfile::tempdir().unwrap();
        let error = HttpUpdateNetwork::new(DEFAULT_UPDATE_URL)
            .download("http://example.test/a.tar.gz", &tmp.path().join("a"), 10)
            .await
            .unwrap_err();
        assert!(error.contains("https"));
    }
}
