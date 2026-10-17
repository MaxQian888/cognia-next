//! Trusted, Host-installed desktop releases and bounded OCI verification.
//! The renderer cannot supply a file path, image, command or digest.

use std::{
    io::Write,
    path::Path,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use cognia_automation::cua_sandbox::managed::{
    refused, DesktopRelease, ManagedDesktopImageVerifier, Result,
};
use cognia_environment::{
    image::ImageReference,
    registry::{
        http::ReqwestTransport, Platform, RegistryClient, RegistryCredentials, RegistryEndpoint,
        RegistryError,
    },
};

pub const RELEASE_FILE: &str = "managed-desktop-release.json";
pub const PROTOCOL: &str = "computer-server-0.3.46";
pub const RECIPE: &str = "7";

/// No embedded digest is guessed before the image has actually been published.
/// An absent release leaves provisioning dormant and cleanup operational.
pub fn load(directory: &Path) -> Result<Option<DesktopRelease>> {
    let path = directory.join(RELEASE_FILE);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(refused("managed_desktop_release_unreadable")),
    };
    if !metadata.is_file() || metadata.len() > 16 * 1024 {
        return Err(refused("managed_desktop_release_invalid"));
    }
    let bytes = std::fs::read(path).map_err(|_| refused("managed_desktop_release_unreadable"))?;
    let release: DesktopRelease =
        serde_json::from_slice(&bytes).map_err(|_| refused("managed_desktop_release_invalid"))?;
    validate_release(&release)?;
    Ok(Some(release))
}

fn validate_release(release: &DesktopRelease) -> Result<()> {
    release.validate()?;
    if release.protocol != PROTOCOL
        || release.recipe_revision != RECIPE
        || release.server_version != "0.3.46"
        || release.architecture != "linux/amd64"
    {
        return Err(refused("managed_desktop_release_mismatch"));
    }
    Ok(())
}

pub struct OciDesktopImageVerifier;

const PROGRESS_INTERVAL: Duration = Duration::from_secs(10);

// Discards bytes exactly like io::sink; RegistryClient remains responsible for
// hashing and size validation. Only numeric metadata survives each write.
struct LayerProgress {
    layer: usize,
    layers: usize,
    expected_bytes: u64,
    downloaded_bytes: u64,
    started: Instant,
    last_report: Instant,
}

impl LayerProgress {
    fn new(layer: usize, layers: usize, expected_bytes: u64) -> Self {
        let started = Instant::now();
        Self {
            layer,
            layers,
            expected_bytes,
            downloaded_bytes: 0,
            started,
            last_report: started,
        }
    }

    fn record(&mut self, bytes: usize, now: Instant) -> bool {
        self.downloaded_bytes = self.downloaded_bytes.saturating_add(bytes as u64);
        if bytes == 0 || now.saturating_duration_since(self.last_report) < PROGRESS_INTERVAL {
            return false;
        }
        self.last_report = now;
        true
    }

    fn diagnostic(&self, verified: bool, now: Instant) -> String {
        format!(
            "desktop image verification: layer={}/{} downloaded_bytes={} expected_bytes={} elapsed_ms={} verified={verified}",
            self.layer, self.layers, self.downloaded_bytes, self.expected_bytes,
            now.saturating_duration_since(self.started).as_millis()
        )
    }
}

impl Write for LayerProgress {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let now = Instant::now();
        if self.record(bytes.len(), now) {
            eprintln!("{}", self.diagnostic(false, now));
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[async_trait]
impl ManagedDesktopImageVerifier for OciDesktopImageVerifier {
    async fn verify(&self, release: &DesktopRelease) -> Result<()> {
        validate_release(release)?;
        tokio::time::timeout(Duration::from_secs(900), verify_image(release))
            .await
            .map_err(|_| refused("managed_desktop_image_verification_timeout"))?
    }
}

async fn verify_image(release: &DesktopRelease) -> Result<()> {
    // Registry errors may contain signed redirect URLs. Only fixed classes
    // and numeric status are safe to expose in Host/operator diagnostics.
    let invalid = |error: RegistryError| {
        eprintln!(
            "desktop image verification: class={} status={:?}",
            error.code(),
            registry_status(&error)
        );
        refused("managed_desktop_image_verification_failed")
    };
    let reference = ImageReference::parse(&release.image)
        .map_err(|_| refused("managed_desktop_release_invalid"))?;
    // Public Cognia release images need no ambient Docker/provider credential.
    let client = RegistryClient::new(ReqwestTransport::default(), RegistryCredentials::empty());
    let endpoint = RegistryEndpoint {
        registry: reference.registry.clone(),
        insecure: false,
    };
    let platform = Platform::linux("amd64");
    let metadata = client
        .fetch_metadata(&endpoint, &reference, std::slice::from_ref(&platform))
        .await
        .map_err(invalid)?;
    if metadata.digest != release.image_digest || metadata.platforms.len() != 1 {
        return Err(refused("managed_desktop_release_mismatch"));
    }
    let mut image = client
        .open_layers(&endpoint, &reference, &platform)
        .await
        .map_err(invalid)?;
    let layers = image.layers().to_vec();
    let total = layers.iter().try_fold(0u64, |total, layer| {
        u64::try_from(layer.size)
            .ok()
            .and_then(|size| total.checked_add(size))
    });
    if layers.is_empty()
        || layers.len() > 128
        || total.is_none_or(|size| size > 4 * 1024 * 1024 * 1024)
    {
        return Err(refused("managed_desktop_image_size_limit"));
    }
    // The existing registry client streams and hashes each blob; nothing is
    // accumulated in memory or written as an untracked Host cache.
    let layer_count = layers.len();
    for (index, layer) in layers.into_iter().enumerate() {
        let mut progress = LayerProgress::new(index + 1, layer_count, layer.size as u64);
        eprintln!("{}", progress.diagnostic(false, Instant::now()));
        image
            .fetch_blob(&layer, &mut progress)
            .await
            .map_err(invalid)?;
        // Success is emitted only after the registry checked both digest and size.
        eprintln!("{}", progress.diagnostic(true, Instant::now()));
    }
    Ok(())
}

fn registry_status(error: &RegistryError) -> Option<u16> {
    match error {
        RegistryError::UnexpectedStatus { status, .. } => Some(*status),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_progress_counts_all_writes_but_reports_at_most_once_per_interval() {
        let mut progress = LayerProgress::new(3, 13, 100_000);
        let start = progress.started;
        for millis in 0..10_000 {
            assert!(!progress.record(1, start + Duration::from_millis(millis)));
        }
        assert_eq!(progress.downloaded_bytes, 10_000);
        assert!(!progress.record(0, start + PROGRESS_INTERVAL));
        assert!(progress.record(5, start + PROGRESS_INTERVAL));
        assert!(!progress.record(5, start + PROGRESS_INTERVAL));
        assert!(!progress.record(5, start + Duration::from_secs(19)));
        assert!(progress.record(5, start + Duration::from_secs(20)));
        assert_eq!(progress.downloaded_bytes, 10_020);
        assert_eq!(
            progress.diagnostic(false, start + Duration::from_secs(20)),
            "desktop image verification: layer=3/13 downloaded_bytes=10020 expected_bytes=100000 elapsed_ms=20000 verified=false"
        );
    }

    #[test]
    fn layer_progress_discards_payload_and_flush_does_not_claim_verification() {
        let mut progress = LayerProgress::new(1, 2, 64);
        let payload = b"https://private.invalid/?signature=secret";
        assert_eq!(progress.write(payload).unwrap(), payload.len());
        progress.flush().unwrap();
        assert_eq!(progress.downloaded_bytes, payload.len() as u64);
        let diagnostic = progress.diagnostic(false, progress.started);
        assert!(!diagnostic.contains("private"));
        assert!(!diagnostic.contains("signature"));
        assert!(!diagnostic.contains("secret"));
        assert!(diagnostic.ends_with("elapsed_ms=0 verified=false"));
    }

    #[test]
    fn registry_diagnostics_never_include_redirect_urls_or_error_bodies() {
        let error = RegistryError::UnexpectedStatus {
            status: 503,
            url: "https://cdn.example.test/blob?signature=private".into(),
        };
        assert_eq!(registry_status(&error), Some(503));
        assert_eq!(error.code(), "registry_unexpected_status");
        assert_eq!(
            registry_status(&RegistryError::Unreachable {
                registry: "cdn.example.test".into(),
                message: "private response".into(),
            }),
            None
        );
    }

    fn release() -> DesktopRelease {
        DesktopRelease {
            image: format!("ghcr.io/cognia/desktop@sha256:{}", "a".repeat(64)),
            image_digest: format!("sha256:{}", "a".repeat(64)),
            architecture: "linux/amd64".into(),
            recipe_revision: RECIPE.into(),
            protocol: PROTOCOL.into(),
            server_version: "0.3.46".into(),
            start_command: "true".into(),
            ready_command: "true".into(),
        }
    }

    #[test]
    fn absent_release_is_dormant_and_wrong_version_never_falls_back() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(dir.path()).unwrap().is_none());
        let mut release = release();
        release.recipe_revision = "1".into();
        std::fs::write(
            dir.path().join(RELEASE_FILE),
            serde_json::to_vec(&release).unwrap(),
        )
        .unwrap();
        assert_eq!(
            load(dir.path()).unwrap_err().code,
            "managed_desktop_release_mismatch"
        );
    }

    #[test]
    fn only_exact_pinned_release_is_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let mut release = release();
        std::fs::write(
            dir.path().join(RELEASE_FILE),
            serde_json::to_vec(&release).unwrap(),
        )
        .unwrap();
        assert_eq!(load(dir.path()).unwrap(), Some(release.clone()));
        release.image = "ghcr.io/cognia/desktop:latest".into();
        std::fs::write(
            dir.path().join(RELEASE_FILE),
            serde_json::to_vec(&release).unwrap(),
        )
        .unwrap();
        assert!(load(dir.path()).is_err());
    }
}
