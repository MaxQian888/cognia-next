//! The update Worker, as a host talks to it (feature `client`).
//!
//! Three requests: the signed catalog for a channel, the live rollout answer
//! for this host, and an archive download. Nothing fetched here is trusted:
//! the catalog is verified against the root the host ships with, the rollout
//! answer only counts when it matches the verified catalog, and an archive is
//! checked against the catalog's sha256 before it is unpacked.
//!
//! Two programs ask: the always-on host's own updater (`cognia-companion`)
//! and, on a Compose host, the deploy agent that swaps the server image
//! (`cognia-deploy-agent host-updates`). Both run [`check_host_release`], so
//! the agent picks a release by the same rule as the host it updates and
//! never takes the host's word for which one.

use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use futures_util::StreamExt as _;
use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt as _;

use crate::host_release::{select_host_release, HostArtifact, HostRelease, HostReleaseQuery};
use crate::verify::{parse_trust_root, verify_signed_catalog, RootPayload, TrustState};

/// The Worker the app also uses (`DEFAULT_CATALOG_URL` in `lib/updates/catalog-client.ts`).
pub const DEFAULT_UPDATE_URL: &str = "https://update.cognia.cn";
/// Read at runtime first, so an operator can pin the root a build trusts.
pub const TRUST_ROOT_ENV: &str = "COGNIA_UPDATE_TRUST_ROOT";
/// The update Worker to ask; defaults to [`DEFAULT_UPDATE_URL`].
pub const UPDATE_URL_ENV: &str = "COGNIA_UPDATE_URL";
/// Largest catalog a host accepts.
const MAX_CATALOG_BYTES: usize = 8 * 1024 * 1024;
/// Largest archive a host downloads when the catalog names no size.
pub const MAX_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024;

/// The root this program trusts: `COGNIA_UPDATE_TRUST_ROOT` at runtime, else
/// the one compiled in from the same variable at build time. `None` turns
/// updates off (reported as such); nothing is installed on unverified
/// metadata.
pub fn trust_root() -> Option<RootPayload> {
    std::env::var(TRUST_ROOT_ENV)
        .ok()
        .and_then(|raw| parse_trust_root(&raw))
        .or_else(|| option_env!("COGNIA_UPDATE_TRUST_ROOT").and_then(parse_trust_root))
}

/// `COGNIA_UPDATE_URL`, else [`DEFAULT_UPDATE_URL`].
pub fn update_url() -> String {
    std::env::var(UPDATE_URL_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_UPDATE_URL.to_owned())
}

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

/// The trust state a program verifies catalogs with, in one file.
///
/// The saved state wins (it has advanced past the shipped root and records
/// the versions seen, the rollback gate) unless the build ships a newer root:
/// a build that ships a rotated root starts from it.
#[derive(Debug, Clone)]
pub struct TrustFile {
    path: PathBuf,
}

impl TrustFile {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn load(&self, shipped: &RootPayload) -> TrustState {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|raw| serde_json::from_str::<TrustState>(&raw).ok())
            .filter(|saved| saved.root.version >= shipped.version)
            .unwrap_or_else(|| TrustState::new(shipped.clone()))
    }

    pub fn save(&self, trust: &TrustState) -> Result<(), String> {
        let parent = self.path.parent().ok_or("trust path has no parent")?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let temp = parent.join(format!(".trust.{}.tmp", std::process::id()));
        let body = serde_json::to_vec_pretty(trust).map_err(|error| error.to_string())?;
        std::fs::write(&temp, body).map_err(|error| error.to_string())?;
        std::fs::rename(&temp, &self.path).map_err(|error| error.to_string())
    }
}

/// What [`check_host_release`] asks about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostCheck {
    pub channel: String,
    /// `darwin-arm64`, `oci-full-amd64`, …
    pub target: String,
    pub current_version: String,
    pub bucket: u32,
    pub manual: bool,
    pub now_ms: i64,
}

/// The release a host may install now, if any.
///
/// Fetch the channel's signed catalog, verify it with `trust` (persisting the
/// advanced trust state), pick the host release for this platform, then ask
/// the Worker whether it is rolling for this host. The Worker can hold a
/// release back; it cannot put forward one the catalog does not sign: its
/// answer counts only when it names the selected release's version and
/// digest.
pub async fn check_host_release(
    network: &dyn UpdateNetwork,
    root: &RootPayload,
    trust: &TrustFile,
    check: &HostCheck,
) -> Result<Option<HostRelease>, String> {
    let bundle = network
        .catalog(&check.channel)
        .await?
        .ok_or_else(|| format!("no catalog is published for the {} channel", check.channel))?;
    let now = DateTime::<Utc>::from_timestamp_millis(check.now_ms).unwrap_or_default();
    let verified = verify_signed_catalog(&bundle, &trust.load(root), now)
        .map_err(|error| error.to_string())?;
    trust.save(&verified.trust)?;
    let query = HostReleaseQuery {
        channel: &check.channel,
        target: &check.target,
        current_version: Some(&check.current_version),
        bucket: check.bucket,
        manual: check.manual,
    };
    let Some(release) = select_host_release(&verified.targets.entries, &query) else {
        return Ok(None);
    };
    let answer = network
        .rollout(&RolloutQuery {
            target: check.target.clone(),
            current_version: check.current_version.clone(),
            channel: check.channel.clone(),
            bucket: check.bucket,
            manual: check.manual,
        })
        .await?;
    Ok(answer
        .filter(|answer| {
            answer.version == release.version
                && digest_matches(answer.digest.as_deref(), &release.artifact)
        })
        .map(|_| release))
}

/// Whether the Worker's digest is the artifact's, with or without `sha256:`.
pub fn digest_matches(answer: Option<&str>, artifact: &HostArtifact) -> bool {
    let strip = |value: &str| value.strip_prefix("sha256:").unwrap_or(value).to_owned();
    let expected = match artifact {
        HostArtifact::Archive { sha256, .. } => strip(sha256),
        HostArtifact::Image { digest, .. } => strip(digest),
    };
    answer.map(strip).as_deref() == Some(expected.as_str())
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
    use crate::test_support;
    use parking_lot::Mutex;

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

    #[test]
    fn saved_trust_wins_unless_the_build_ships_a_newer_root() {
        let tmp = tempfile::tempdir().unwrap();
        let file = TrustFile::new(tmp.path().join("updates").join("trust.json"));
        let root = |version: u64| -> RootPayload {
            let mut root = test_support::root();
            root.version = version;
            root
        };
        assert_eq!(file.load(&root(1)).root.version, 1);
        let mut advanced = TrustState::new(root(2));
        advanced.seen_versions.targets = Some(7);
        file.save(&advanced).unwrap();
        assert_eq!(file.load(&root(1)), advanced);
        assert_eq!(file.load(&root(3)).root.version, 3);
    }

    #[test]
    fn a_digest_matches_with_or_without_its_algorithm() {
        let image = HostArtifact::Image {
            repository: "ghcr.io/x/cognia-server".into(),
            digest: format!("sha256:{}", "a".repeat(64)),
        };
        assert!(digest_matches(Some(&"a".repeat(64)), &image));
        assert!(digest_matches(
            Some(&format!("sha256:{}", "a".repeat(64))),
            &image
        ));
        assert!(!digest_matches(Some(&"b".repeat(64)), &image));
        assert!(!digest_matches(None, &image));
    }

    /// A Worker that answers from memory and records the rollout questions.
    struct FakeWorker {
        bundle: Option<Value>,
        answer: Option<RolloutAnswer>,
        asked: Mutex<Vec<RolloutQuery>>,
    }

    #[async_trait]
    impl UpdateNetwork for FakeWorker {
        async fn catalog(&self, _channel: &str) -> Result<Option<Value>, String> {
            Ok(self.bundle.clone())
        }
        async fn rollout(&self, query: &RolloutQuery) -> Result<Option<RolloutAnswer>, String> {
            self.asked.lock().push(query.clone());
            Ok(self.answer.clone())
        }
        async fn download(&self, _: &str, _: &Path, _: u64) -> Result<(), String> {
            Err("not here".into())
        }
    }

    const NOW_MS: i64 = 1_790_000_000_000;

    fn signed_digest() -> String {
        format!("sha256:{}", "d".repeat(64))
    }

    fn image_worker(answer: Option<RolloutAnswer>) -> FakeWorker {
        let digest = signed_digest();
        let now = DateTime::<Utc>::from_timestamp_millis(NOW_MS).unwrap();
        let entries = test_support::host_release_entries(
            "1.5.0",
            "stable",
            "oci-full-amd64",
            serde_json::json!({ "image": "ghcr.io/x/cognia-server", "digest": digest }),
        );
        FakeWorker {
            bundle: Some(test_support::sign_bundle(entries, 1, now)),
            answer,
            asked: Mutex::new(Vec::new()),
        }
    }

    fn check(manual: bool) -> HostCheck {
        HostCheck {
            channel: "stable".into(),
            target: "oci-full-amd64".into(),
            current_version: "1.4.0".into(),
            bucket: 42,
            manual,
            now_ms: NOW_MS,
        }
    }

    #[tokio::test]
    async fn a_release_is_offered_only_when_the_worker_names_its_version_and_digest() {
        let tmp = tempfile::tempdir().unwrap();
        let trust = TrustFile::new(tmp.path().join("trust.json"));
        let root = test_support::root();

        let digest = signed_digest();
        let worker = image_worker(Some(RolloutAnswer {
            version: "1.5.0".into(),
            digest: Some(digest.clone()),
        }));
        let release = check_host_release(&worker, &root, &trust, &check(true))
            .await
            .unwrap()
            .expect("rolling");
        assert_eq!(release.version, "1.5.0");
        assert_eq!(
            release.artifact.image_reference().as_deref(),
            Some(format!("ghcr.io/x/cognia-server@{digest}").as_str())
        );
        let asked = worker.asked.lock().clone();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].manual);
        assert_eq!(asked[0].bucket, 42);
        assert!(
            tmp.path().join("trust.json").is_file(),
            "trust advanced and saved"
        );

        // Held back.
        let worker = image_worker(None);
        assert_eq!(
            check_host_release(&worker, &root, &trust, &check(false))
                .await
                .unwrap(),
            None
        );
        // A digest the catalog does not sign is not a release.
        let worker = image_worker(Some(RolloutAnswer {
            version: "1.5.0".into(),
            digest: Some(format!("sha256:{}", "e".repeat(64))),
        }));
        assert_eq!(
            check_host_release(&worker, &root, &trust, &check(false))
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn no_catalog_or_a_forged_one_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let trust = TrustFile::new(tmp.path().join("trust.json"));
        let root = test_support::root();
        let none = FakeWorker {
            bundle: None,
            answer: None,
            asked: Mutex::new(Vec::new()),
        };
        let error = check_host_release(&none, &root, &trust, &check(false))
            .await
            .unwrap_err();
        assert!(error.contains("no catalog"), "{error}");

        let mut forged = image_worker(None);
        let bundle = forged.bundle.as_mut().unwrap();
        bundle["targets"]["signed"]["version"] = serde_json::json!(99);
        assert!(check_host_release(&forged, &root, &trust, &check(false))
            .await
            .is_err());
        assert!(
            forged.asked.lock().is_empty(),
            "never asks about an unverified release"
        );
    }
}
