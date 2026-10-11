//! Which host release an always-on host may install.
//!
//! A host release ships as one unit: its server and brain come from one build
//! (ADR-0175's exact versions), so the catalog lists it as a `host-server`
//! entry carrying the artifact and a `host-brain` entry of the same version,
//! channel and target carrying the brain's identity. Both name the command
//! contract. [`host_releases`] keeps only matched pairs whose two halves name
//! the same contract and whose artifact is pinned (an archive's sha256, an
//! image's digest), so a release published half-way, or with a server and
//! brain that disagree, is never offered. The signer refuses to sign either
//! (`scripts/release/update-catalog.mjs`); this is the same rule on the side
//! that installs.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use crate::verify::{CatalogEntry, Rollout};

/// The asset id every host release is published under.
pub const HOST_ASSET_ID: &str = "host";

const ROLLOUT_BUCKETS: f64 = 10_000.0;

/// What a host downloads, pinned by the signed catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostArtifact {
    /// A macOS install archive (`scripts/build/package-host-archive.mjs`).
    Archive {
        url: String,
        sha256: String,
        size_bytes: Option<u64>,
    },
    /// The Compose image (`Dockerfile.cognia-server`), by digest only.
    Image { repository: String, digest: String },
}

impl HostArtifact {
    /// `repository@digest`, the only form a Compose host pulls.
    pub fn image_reference(&self) -> Option<String> {
        match self {
            Self::Image { repository, digest } => Some(format!("{repository}@{digest}")),
            Self::Archive { .. } => None,
        }
    }
}

/// One installable host release for one platform.
#[derive(Debug, Clone, PartialEq)]
pub struct HostRelease {
    pub version: String,
    pub channel: String,
    pub target: String,
    pub criticality: String,
    pub released_at: Option<String>,
    pub release_notes: Option<String>,
    /// The command contract both the server and the brain serve.
    pub contract_version: u32,
    pub catalog_hash: String,
    pub artifact: HostArtifact,
    pub rollout: Option<Rollout>,
}

/// Where a host stands, for [`select_host_release`].
#[derive(Debug, Clone, Copy)]
pub struct HostReleaseQuery<'a> {
    /// The channel the host follows (pushed by its owner's device).
    pub channel: &'a str,
    /// `darwin-arm64`, `darwin-x64`, `oci-slim-amd64`, `oci-full-amd64`.
    pub target: &'a str,
    /// The installed release; `None` offers any.
    pub current_version: Option<&'a str>,
    /// The host's stable rollout bucket, 0..10000.
    pub bucket: u32,
    /// Someone asked for this update: skips the percentage gate only.
    pub manual: bool,
}

/// Numeric semver compare tolerating a `v` prefix and a prerelease suffix;
/// the same order as `compareVersions` in `lib/updates/catalog-lookup.ts`.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    fn parse(version: &str) -> ([u64; 3], &str) {
        let version = version
            .strip_prefix('v')
            .or_else(|| version.strip_prefix('V'))
            .unwrap_or(version);
        // Like JavaScript's `split("-", 2)`: the prerelease ends at a second hyphen.
        let mut pieces = version.split('-');
        let core = pieces.next().unwrap_or_default();
        let pre = pieces.next().unwrap_or_default();
        let mut parts = [0u64; 3];
        for (slot, part) in parts.iter_mut().zip(core.split('.')) {
            let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
            *slot = digits.parse().unwrap_or(0);
        }
        (parts, pre)
    }
    let (left, left_pre) = parse(a);
    let (right, right_pre) = parse(b);
    left.cmp(&right).then_with(|| match (left_pre, right_pre) {
        (l, r) if l == r => Ordering::Equal,
        // A release outranks any prerelease of the same core version.
        ("", _) => Ordering::Greater,
        (_, "") => Ordering::Less,
        (l, r) => l.cmp(r),
    })
}

/// Channels a host on `channel` may see.
fn visible_channels(channel: &str) -> &'static [&'static str] {
    match channel {
        "canary" => &["stable", "beta", "canary"],
        "beta" => &["stable", "beta"],
        _ => &["stable"],
    }
}

/// Whether a rollout window offers this host the release now. A paused or
/// revoked rollout refuses even a manual request; `manual` skips only the
/// percentage, as `rolloutVerdict` in `lib/updates/rollout.ts` does.
fn rollout_offers(rollout: Option<&Rollout>, bucket: u32, manual: bool) -> bool {
    let Some(rollout) = rollout else {
        return true;
    };
    if rollout.revoked || rollout.paused {
        return false;
    }
    if manual {
        return true;
    }
    let percentage = rollout.percentage.clamp(0.0, 100.0);
    f64::from(bucket) < percentage / 100.0 * ROLLOUT_BUCKETS
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn artifact_of(server: &CatalogEntry, target: &str) -> Option<HostArtifact> {
    if target.starts_with("oci-") {
        let repository = server.image.as_deref()?;
        let last = repository.rsplit('/').next().unwrap_or_default();
        let digest = server.digest.as_deref()?;
        let pinned = digest.strip_prefix("sha256:").is_some_and(is_sha256_hex);
        (!last.is_empty() && !repository.contains('@') && !last.contains(':') && pinned).then(
            || HostArtifact::Image {
                repository: repository.to_owned(),
                digest: digest.to_owned(),
            },
        )
    } else {
        let url = server.url.as_deref()?;
        let sha256 = server.sha256.as_deref()?;
        (url.starts_with("https://") && is_sha256_hex(sha256)).then(|| HostArtifact::Archive {
            url: url.to_owned(),
            sha256: sha256.to_owned(),
            size_bytes: server.size_bytes,
        })
    }
}

/// Every complete host release in `entries`: matched `host-server` and
/// `host-brain` pairs naming one contract, with a pinned artifact, neither
/// revoked.
pub fn host_releases(entries: &[CatalogEntry]) -> Vec<HostRelease> {
    type Unit<'a> = (&'a str, &'a str, &'a str);
    let mut servers: BTreeMap<Unit<'_>, Vec<&CatalogEntry>> = BTreeMap::new();
    let mut brains: BTreeMap<Unit<'_>, Vec<&CatalogEntry>> = BTreeMap::new();
    for entry in entries.iter().filter(|e| e.asset_id == HOST_ASSET_ID) {
        let Some(target) = entry.target.as_deref() else {
            continue;
        };
        let unit = (entry.channel.as_str(), entry.version.as_str(), target);
        match entry.kind.as_str() {
            "host-server" => servers.entry(unit).or_default().push(entry),
            "host-brain" => brains.entry(unit).or_default().push(entry),
            _ => {}
        }
    }

    let mut releases = Vec::new();
    for (unit @ (channel, version, target), server) in servers {
        // A unit listed twice is ambiguous: which artifact was meant?
        let ([server], Some([brain])) = (server.as_slice(), brains.get(&unit).map(Vec::as_slice))
        else {
            continue;
        };
        if server.revoked || brain.revoked {
            continue;
        }
        let (Some(contract_version), Some(catalog_hash)) =
            (server.contract_version, server.catalog_hash.as_deref())
        else {
            continue;
        };
        if brain.contract_version != Some(contract_version)
            || brain.catalog_hash.as_deref() != Some(catalog_hash)
            || !is_sha256_hex(catalog_hash)
        {
            continue;
        }
        let Some(artifact) = artifact_of(server, target) else {
            continue;
        };
        releases.push(HostRelease {
            version: version.to_owned(),
            channel: channel.to_owned(),
            target: target.to_owned(),
            criticality: server
                .criticality
                .clone()
                .unwrap_or_else(|| "routine".to_owned()),
            released_at: server.released_at.clone(),
            release_notes: server.release_notes.clone(),
            contract_version,
            catalog_hash: catalog_hash.to_owned(),
            artifact,
            rollout: server.rollout.clone(),
        });
    }
    releases
}

/// The newest release this host may install now, or `None` when it is
/// current. Checks the channel, platform, version and rollout window.
pub fn select_host_release(
    entries: &[CatalogEntry],
    query: &HostReleaseQuery<'_>,
) -> Option<HostRelease> {
    let channels = visible_channels(query.channel);
    host_releases(entries)
        .into_iter()
        .filter(|release| release.target == query.target)
        .filter(|release| channels.contains(&release.channel.as_str()))
        .filter(|release| {
            query.current_version.is_none_or(|current| {
                compare_versions(&release.version, current) == Ordering::Greater
            })
        })
        .filter(|release| rollout_offers(release.rollout.as_ref(), query.bucket, query.manual))
        .max_by(|a, b| compare_versions(&a.version, &b.version))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::verify::tests::fixture;
    use crate::verify::verify_signed_catalog;
    use serde_json::json;

    fn verified_entries() -> Vec<CatalogEntry> {
        let (bundle, trust, now) = fixture();
        verify_signed_catalog(&bundle, &trust, now)
            .expect("fixture verifies")
            .targets
            .entries
    }

    fn query<'a>(
        channel: &'a str,
        target: &'a str,
        current: Option<&'a str>,
    ) -> HostReleaseQuery<'a> {
        HostReleaseQuery {
            channel,
            target,
            current_version: current,
            bucket: 0,
            manual: false,
        }
    }

    fn entry(kind: &str, extra: serde_json::Value) -> CatalogEntry {
        let mut value = json!({
            "assetId": "host",
            "kind": kind,
            "version": "2.0.0",
            "channel": "stable",
            "target": "darwin-arm64",
            "contractVersion": 3,
            "catalogHash": "c".repeat(64),
        });
        if kind == "host-server" {
            value["url"] = json!("https://example.test/host.tar.gz");
            value["sha256"] = json!("a".repeat(64));
        }
        for (key, field) in extra.as_object().expect("object") {
            value[key] = field.clone();
        }
        serde_json::from_value(value).expect("entry")
    }

    #[test]
    fn reads_the_signed_fixture_as_four_complete_releases() {
        let releases = host_releases(&verified_entries());
        assert_eq!(releases.len(), 4);
        let image = releases
            .iter()
            .find(|r| r.target == "oci-full-amd64" && r.channel == "stable")
            .expect("stable image");
        assert_eq!(image.version, "1.4.0");
        assert!(image
            .artifact
            .image_reference()
            .expect("image")
            .starts_with("ghcr.io/maxqian888/cognia-server@sha256:"));
    }

    #[test]
    fn offers_the_newest_release_on_the_hosts_channel_and_platform() {
        let entries = verified_entries();
        let stable = select_host_release(&entries, &query("stable", "darwin-arm64", Some("1.3.0")))
            .expect("stable update");
        assert_eq!(stable.version, "1.4.0");
        assert!(matches!(stable.artifact, HostArtifact::Archive { .. }));
        // Beta sees stable and beta.
        let beta = select_host_release(&entries, &query("beta", "darwin-arm64", Some("1.3.0")))
            .expect("beta update");
        assert_eq!(beta.version, "1.5.0-beta.1");
        // Current, or another platform: nothing.
        assert!(
            select_host_release(&entries, &query("stable", "darwin-arm64", Some("1.4.0")))
                .is_none()
        );
        assert!(select_host_release(&entries, &query("stable", "darwin-x64", None)).is_none());
    }

    #[test]
    fn never_offers_half_a_release_or_one_whose_halves_disagree() {
        let server = entry("host-server", json!({}));
        let brain = entry("host-brain", json!({}));
        assert_eq!(host_releases(&[server.clone(), brain.clone()]).len(), 1);
        assert!(host_releases(std::slice::from_ref(&server)).is_empty());
        assert!(host_releases(std::slice::from_ref(&brain)).is_empty());
        let split = entry("host-brain", json!({ "contractVersion": 4 }));
        assert!(host_releases(&[server.clone(), split]).is_empty());
        let revoked = entry("host-brain", json!({ "revoked": true }));
        assert!(host_releases(&[server.clone(), revoked]).is_empty());
        // Listed twice: ambiguous, so neither.
        assert!(host_releases(&[server.clone(), server, brain]).is_empty());
    }

    #[test]
    fn needs_a_pinned_artifact() {
        let brain = entry("host-brain", json!({}));
        for bad in [
            json!({ "url": "http://example.test/host.tar.gz" }),
            json!({ "sha256": "not-a-digest" }),
            json!({ "url": null }),
        ] {
            assert!(host_releases(&[entry("host-server", bad), brain.clone()]).is_empty());
        }
        let oci_brain = entry("host-brain", json!({ "target": "oci-full-amd64" }));
        let digest = format!("sha256:{}", "d".repeat(64));
        for (image, digest) in [
            ("ghcr.io/o/cognia-server:latest", digest.as_str()),
            ("ghcr.io/o/cognia-server", "latest"),
            ("ghcr.io/o/cognia-server@sha256:x", digest.as_str()),
        ] {
            let server = entry(
                "host-server",
                json!({ "target": "oci-full-amd64", "image": image, "digest": digest }),
            );
            assert!(
                host_releases(&[server, oci_brain.clone()]).is_empty(),
                "{image} {digest}"
            );
        }
        // A registry with a port is still a repository.
        let ported = entry(
            "host-server",
            json!({ "target": "oci-full-amd64", "image": "registry.local:5000/cognia-server", "digest": digest }),
        );
        assert_eq!(host_releases(&[ported, oci_brain]).len(), 1);
    }

    #[test]
    fn follows_the_rollout_window_and_lets_a_request_skip_only_its_percentage() {
        let brain = entry("host-brain", json!({}));
        let partial = entry("host-server", json!({ "rollout": { "percentage": 10 } }));
        let entries = [partial, brain.clone()];
        let mut at = query("stable", "darwin-arm64", Some("1.0.0"));
        at.bucket = 999;
        assert!(select_host_release(&entries, &at).is_some());
        at.bucket = 1000;
        assert!(select_host_release(&entries, &at).is_none());
        at.manual = true;
        assert!(select_host_release(&entries, &at).is_some());

        let paused = entry(
            "host-server",
            json!({ "rollout": { "percentage": 100, "paused": true } }),
        );
        assert!(select_host_release(&[paused, brain], &at).is_none());
    }

    #[test]
    fn orders_versions_like_the_app() {
        assert_eq!(compare_versions("1.10.0", "1.9.9"), Ordering::Greater);
        assert_eq!(compare_versions("v1.2.0", "1.2.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.2.0", "1.2.0-beta.1"), Ordering::Greater);
        assert_eq!(
            compare_versions("1.2.0-beta.2", "1.2.0-beta.1"),
            Ordering::Greater
        );
        assert_eq!(compare_versions("1.2", "1.2.0"), Ordering::Equal);
    }
}
