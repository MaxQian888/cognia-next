//! Trusted, Host-installed desktop releases and bounded OCI verification.
//! The renderer cannot supply a file path, image, command or digest.

use std::{path::Path, time::Duration};

use async_trait::async_trait;
use cognia_automation::cua_sandbox::managed::{
    refused, DesktopRelease, ManagedDesktopImageVerifier, Result,
};
use cognia_environment::{
    image::ImageReference,
    registry::{
        http::ReqwestTransport, Platform, RegistryClient, RegistryCredentials, RegistryEndpoint,
    },
};

pub const RELEASE_FILE: &str = "managed-desktop-release.json";
pub const PROTOCOL: &str = "computer-server-0.3.46";
pub const RECIPE: &str = "3";

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
    let invalid = |_| refused("managed_desktop_image_verification_failed");
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
    for layer in layers {
        image
            .fetch_blob(&layer, &mut std::io::sink())
            .await
            .map_err(invalid)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release() -> DesktopRelease {
        DesktopRelease {
            image: format!("ghcr.io/cognia/desktop@sha256:{}", "a".repeat(64)),
            image_digest: format!("sha256:{}", "a".repeat(64)),
            architecture: "linux/amd64".into(),
            recipe_revision: "3".into(),
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
