//! The release a fresh install takes, and its archive on this machine.
//!
//! The same owners self-update uses: the channel's signed catalog verified
//! against the trust root this build ships (`verify_signed_catalog` through a
//! [`TrustFile`]), [`select_host_release`] with no current version, and the
//! update Worker's streamed download, checked against the catalog's sha256
//! before anything leaves this machine. A fresh install is something the
//! user asked for, so it skips the percentage gate the way a manual update
//! does; the Worker's per-host rollout answer is a question about upgrading an
//! installed version and is not asked.

use std::path::{Path, PathBuf};

use cognia_update_catalog::client::{TrustFile, UpdateNetwork, MAX_ARCHIVE_BYTES};
use cognia_update_catalog::host_release::{
    select_host_release, HostArtifact, HostRelease, HostReleaseQuery,
};
use cognia_update_catalog::verify::{verify_signed_catalog, RootPayload};

/// Why no archive could be had.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ReleaseError {
    #[error("this build ships no update trust root, so no release can be verified")]
    NoTrustRoot,
    #[error("the update service could not be reached: {0}")]
    Unreachable(String),
    #[error("no catalog is published for the {0} channel")]
    NoCatalog(String),
    #[error("the catalog did not verify: {0}")]
    Untrusted(String),
    #[error("the {channel} channel has no Host release for {target}")]
    NoRelease { channel: String, target: String },
    #[error("the {target} release is a container image, not an install archive")]
    NotAnArchive { target: String },
    #[error("the downloaded archive does not match the catalog's sha256")]
    DigestMismatch,
    #[error("{0}")]
    Io(String),
}

/// A verified archive on this machine, ready to upload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalArchive {
    pub release: VerifiedRelease,
    pub path: PathBuf,
    pub len: u64,
}

/// The parts of a catalog release the remote `stage` is told to expect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedRelease {
    pub version: String,
    pub target: String,
    pub sha256: String,
    pub contract_version: u32,
    pub catalog_hash: String,
    pub url: String,
    pub size_bytes: Option<u64>,
}

impl VerifiedRelease {
    fn from_host_release(release: &HostRelease) -> Result<Self, ReleaseError> {
        let HostArtifact::Archive {
            url,
            sha256,
            size_bytes,
        } = &release.artifact
        else {
            return Err(ReleaseError::NotAnArchive {
                target: release.target.clone(),
            });
        };
        Ok(Self {
            version: release.version.clone(),
            target: release.target.clone(),
            sha256: sha256
                .strip_prefix("sha256:")
                .unwrap_or(sha256)
                .to_ascii_lowercase(),
            contract_version: release.contract_version,
            catalog_hash: release.catalog_hash.clone(),
            url: url.clone(),
            size_bytes: *size_bytes,
        })
    }

    /// `cognia-host-<version>-<target>.tar.gz`, the name the archive is built
    /// under and the top directory inside it.
    pub fn archive_name(&self) -> String {
        format!("{}.tar.gz", self.top_dir())
    }

    pub fn top_dir(&self) -> String {
        format!("cognia-host-{}-{}", self.version, self.target)
    }
}

/// Pick the newest release for `target` on `channel` from the verified
/// catalog. The advanced trust state is saved, as self-update saves it.
pub async fn select_install_release(
    network: &dyn UpdateNetwork,
    root: Option<&RootPayload>,
    trust: &TrustFile,
    channel: &str,
    target: &str,
    now_ms: i64,
) -> Result<VerifiedRelease, ReleaseError> {
    let root = root.ok_or(ReleaseError::NoTrustRoot)?;
    let bundle = network
        .catalog(channel)
        .await
        .map_err(ReleaseError::Unreachable)?
        .ok_or_else(|| ReleaseError::NoCatalog(channel.to_owned()))?;
    let now = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_ms).unwrap_or_default();
    let verified = verify_signed_catalog(&bundle, &trust.load(root), now)
        .map_err(|error| ReleaseError::Untrusted(error.to_string()))?;
    trust.save(&verified.trust).map_err(ReleaseError::Io)?;
    let query = HostReleaseQuery {
        channel,
        target,
        current_version: None,
        bucket: 0,
        manual: true,
    };
    let release = select_host_release(&verified.targets.entries, &query).ok_or_else(|| {
        ReleaseError::NoRelease {
            channel: channel.to_owned(),
            target: target.to_owned(),
        }
    })?;
    VerifiedRelease::from_host_release(&release)
}

/// Download `release` into `dir` and check it against the catalog's sha256.
/// A mismatching file is removed, never uploaded.
pub async fn download_verified(
    network: &dyn UpdateNetwork,
    release: &VerifiedRelease,
    dir: &Path,
) -> Result<LocalArchive, ReleaseError> {
    let path = dir.join(release.archive_name());
    let max_bytes = release.size_bytes.unwrap_or(MAX_ARCHIVE_BYTES);
    network
        .download(&release.url, &path, max_bytes)
        .await
        .map_err(ReleaseError::Unreachable)?;
    let digest = {
        let path = path.clone();
        tokio::task::spawn_blocking(move || cognia_host_service::install_home::sha256_file(&path))
            .await
            .map_err(|error| ReleaseError::Io(error.to_string()))?
            .map_err(|error| ReleaseError::Io(error.to_string()))?
    };
    if digest != release.sha256 {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(ReleaseError::DigestMismatch);
    }
    let len = tokio::fs::metadata(&path)
        .await
        .map_err(|error| ReleaseError::Io(error.to_string()))?
        .len();
    Ok(LocalArchive {
        release: release.clone(),
        path,
        len,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use cognia_update_catalog::client::{RolloutAnswer, RolloutQuery};
    use cognia_update_catalog::test_support::{host_release_entries, root, sign_bundle};
    use serde_json::{json, Value};

    struct FakeNetwork {
        bundle: Option<Value>,
        archive: Vec<u8>,
    }

    #[async_trait]
    impl UpdateNetwork for FakeNetwork {
        async fn catalog(&self, _channel: &str) -> Result<Option<Value>, String> {
            Ok(self.bundle.clone())
        }
        async fn rollout(&self, _query: &RolloutQuery) -> Result<Option<RolloutAnswer>, String> {
            panic!("a fresh install never asks the rollout question");
        }
        async fn download(&self, _url: &str, destination: &Path, max: u64) -> Result<(), String> {
            if self.archive.len() as u64 > max {
                return Err("larger than the catalog says".into());
            }
            tokio::fs::write(destination, &self.archive)
                .await
                .map_err(|error| error.to_string())
        }
    }

    const NOW_MS: i64 = 1_792_000_000_000;

    fn bundle(target: &str, sha256: &str) -> Value {
        let now = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(NOW_MS).unwrap();
        sign_bundle(
            host_release_entries(
                "1.4.0",
                "stable",
                target,
                json!({ "url": "https://update.cognia.cn/a.tar.gz", "sha256": sha256 }),
            ),
            3,
            now,
        )
    }

    fn digest(bytes: &[u8]) -> String {
        use sha2::Digest as _;
        hex::encode(sha2::Sha256::digest(bytes))
    }

    #[tokio::test]
    async fn a_fresh_install_takes_the_signed_release_for_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let trust = TrustFile::new(dir.path().join("trust.json"));
        let network = FakeNetwork {
            bundle: Some(bundle("linux-x64", &"a".repeat(64))),
            archive: Vec::new(),
        };
        let release = select_install_release(
            &network,
            Some(&root()),
            &trust,
            "stable",
            "linux-x64",
            NOW_MS,
        )
        .await
        .expect("release");
        assert_eq!(release.version, "1.4.0");
        assert_eq!(release.sha256, "a".repeat(64));
        assert_eq!(release.contract_version, 3);
        assert_eq!(release.archive_name(), "cognia-host-1.4.0-linux-x64.tar.gz");
        // The advanced trust state is saved, as self-update saves it.
        assert!(dir.path().join("trust.json").exists());

        let missing = select_install_release(
            &network,
            Some(&root()),
            &trust,
            "stable",
            "linux-arm64",
            NOW_MS,
        )
        .await;
        assert!(matches!(missing, Err(ReleaseError::NoRelease { .. })));
        assert_eq!(
            select_install_release(&network, None, &trust, "stable", "linux-x64", NOW_MS).await,
            Err(ReleaseError::NoTrustRoot)
        );
    }

    #[tokio::test]
    async fn a_tampered_catalog_or_archive_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let trust = TrustFile::new(dir.path().join("trust.json"));
        let mut tampered = bundle("linux-x64", &"a".repeat(64));
        tampered["targets"]["signed"]["entries"][0]["sha256"] = json!("b".repeat(64));
        let network = FakeNetwork {
            bundle: Some(tampered),
            archive: Vec::new(),
        };
        assert!(matches!(
            select_install_release(
                &network,
                Some(&root()),
                &trust,
                "stable",
                "linux-x64",
                NOW_MS
            )
            .await,
            Err(ReleaseError::Untrusted(_))
        ));

        let bytes = b"the real archive".to_vec();
        let good = FakeNetwork {
            bundle: Some(bundle("linux-x64", &digest(&bytes))),
            archive: bytes.clone(),
        };
        let release =
            select_install_release(&good, Some(&root()), &trust, "stable", "linux-x64", NOW_MS)
                .await
                .unwrap();
        let local = download_verified(&good, &release, dir.path())
            .await
            .unwrap();
        assert_eq!(local.len, bytes.len() as u64);
        assert_eq!(std::fs::read(&local.path).unwrap(), bytes);

        let swapped = FakeNetwork {
            bundle: None,
            archive: b"something else".to_vec(),
        };
        assert_eq!(
            download_verified(&swapped, &release, dir.path()).await,
            Err(ReleaseError::DigestMismatch)
        );
        assert!(!dir.path().join(release.archive_name()).exists());
    }
}
