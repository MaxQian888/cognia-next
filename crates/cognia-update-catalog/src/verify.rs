//! Verifying a signed catalog bundle against a trusted root.
//!
//! A port of `lib/updates/catalog-verify.ts`, kept rule for rule so a bundle
//! the app accepts is exactly a bundle a host accepts. Signatures cover the
//! RFC 8785 canonical form of each role's `signed` object as it arrived (the
//! raw JSON, not a re-serialized struct), so a field this build does not know
//! about is still covered and still checked.

use std::collections::BTreeMap;

use base64::Engine as _;
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The four TUF roles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogRole {
    Root,
    Timestamp,
    Snapshot,
    Targets,
}

impl CatalogRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Root => "root",
            Self::Timestamp => "timestamp",
            Self::Snapshot => "snapshot",
            Self::Targets => "targets",
        }
    }
}

impl std::fmt::Display for CatalogRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Why a bundle was refused; the same vocabulary as the TypeScript client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectionReason {
    Signature,
    Threshold,
    Expired,
    Rollback,
    RevokedKey,
    UnknownKey,
    RoleMismatch,
    SnapshotMismatch,
    Malformed,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{role} metadata refused ({reason:?}): {message}")]
pub struct CatalogError {
    pub reason: RejectionReason,
    pub role: CatalogRole,
    pub message: String,
}

impl CatalogError {
    fn new(reason: RejectionReason, role: CatalogRole, message: impl Into<String>) -> Self {
        Self {
            reason,
            role,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogKey {
    pub keyid: String,
    /// Only ed25519 is accepted; anything else is a rejection.
    pub keytype: String,
    /// Lowercase hex of the 32-byte raw public key.
    pub public_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleSpec {
    pub keyids: Vec<String>,
    pub threshold: u32,
}

/// The root payload: every role's keys and threshold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootPayload {
    #[serde(rename = "_type")]
    pub kind: String,
    pub version: u64,
    pub expires: String,
    pub keys: BTreeMap<String, CatalogKey>,
    pub roles: BTreeMap<String, RoleSpec>,
    /// Keys that must never verify anything again, even if still listed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub revoked_key_ids: Vec<String>,
}

/// A staged-rollout window, as a catalog entry carries it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rollout {
    pub percentage: f64,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub revoked: bool,
}

/// One published release; the fields a host reads. Unknown fields are
/// ignored here but were covered by the signature.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub asset_id: String,
    pub kind: String,
    #[serde(default)]
    pub executor: Option<String>,
    pub version: String,
    pub channel: String,
    #[serde(default)]
    pub criticality: Option<String>,
    #[serde(default)]
    pub released_at: Option<String>,
    #[serde(default)]
    pub release_notes: Option<String>,
    #[serde(default)]
    pub rollout: Option<Rollout>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    /// Archive releases: sha256 of the archive, pinned by the signature.
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    /// Image releases: the repository, without tag or digest.
    #[serde(default)]
    pub image: Option<String>,
    /// Image releases: the `sha256:` manifest digest.
    #[serde(default)]
    pub digest: Option<String>,
    #[serde(default)]
    pub contract_version: Option<u32>,
    #[serde(default)]
    pub catalog_hash: Option<String>,
    #[serde(default)]
    pub revoked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TargetsPayload {
    pub version: u64,
    pub expires: String,
    pub entries: Vec<CatalogEntry>,
}

/// Highest version seen per role. Refusing a lower one is the rollback gate.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SeenVersions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub targets: Option<u64>,
}

/// What a client carries between checks: the root it trusts (seeded from the
/// one it shipped with, advanced in place) and the versions it has seen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustState {
    pub root: RootPayload,
    pub seen_versions: SeenVersions,
}

impl TrustState {
    /// Fresh trust in a shipped root.
    pub fn new(root: RootPayload) -> Self {
        let seen_versions = SeenVersions {
            root: Some(root.version),
            ..SeenVersions::default()
        };
        Self {
            root,
            seen_versions,
        }
    }
}

/// A verified bundle: the targets to act on, and the trust state to persist.
#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedCatalog {
    pub targets: TargetsPayload,
    pub trust: TrustState,
}

/// Parse a trust root: JSON, or base64 of JSON (the env form the signer prints).
pub fn parse_trust_root(raw: &str) -> Option<RootPayload> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let json = if raw.starts_with('{') {
        raw.to_owned()
    } else {
        let bytes = base64::engine::general_purpose::STANDARD.decode(raw).ok()?;
        String::from_utf8(bytes).ok()?
    };
    let root: RootPayload = serde_json::from_str(&json).ok()?;
    (root.kind == "root"
        && root.roles.contains_key("root")
        && root.roles.contains_key("targets")
        && DateTime::parse_from_rfc3339(&root.expires).is_ok())
    .then_some(root)
}

fn malformed(role: CatalogRole, message: impl Into<String>) -> CatalogError {
    CatalogError::new(RejectionReason::Malformed, role, message)
}

fn decode_hex<const N: usize>(hex_str: &str) -> Option<[u8; N]> {
    let bytes = hex::decode(hex_str).ok()?;
    bytes.try_into().ok()
}

/// Check one role document against `root`: declared type, expiry, monotonic
/// version, then the signature threshold.
fn verify_role(
    role: CatalogRole,
    doc: &Value,
    root: &RootPayload,
    now: DateTime<Utc>,
    seen: Option<u64>,
) -> Result<(), CatalogError> {
    let payload = doc
        .get("signed")
        .filter(|value| value.is_object())
        .ok_or_else(|| malformed(role, format!("{role} document is malformed")))?;
    let signatures = doc
        .get("signatures")
        .and_then(Value::as_array)
        .ok_or_else(|| malformed(role, format!("{role} document is malformed")))?;
    if payload.get("_type").and_then(Value::as_str) != Some(role.as_str()) {
        return Err(CatalogError::new(
            RejectionReason::RoleMismatch,
            role,
            format!("expected _type {role}"),
        ));
    }
    let expires = payload
        .get("expires")
        .and_then(Value::as_str)
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .ok_or_else(|| malformed(role, format!("{role} expiry is unparseable")))?;
    if expires.with_timezone(&Utc) <= now {
        return Err(CatalogError::new(
            RejectionReason::Expired,
            role,
            format!("{role} metadata expired"),
        ));
    }
    let version = payload
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| malformed(role, format!("{role} version is not an integer")))?;
    if let Some(seen) = seen {
        if version < seen {
            return Err(CatalogError::new(
                RejectionReason::Rollback,
                role,
                format!("{role} version {version} is older than trusted {seen}"),
            ));
        }
    }

    let spec = root
        .roles
        .get(role.as_str())
        .filter(|spec| spec.threshold >= 1)
        .ok_or_else(|| malformed(role, format!("root declares no {role} role")))?;
    let message = cognia_canonical_json::canonical_bytes(payload)
        .map_err(|error| malformed(role, error.to_string()))?;
    let mut counted: Vec<&str> = Vec::new();
    for signature in signatures {
        let Some(keyid) = signature.get("keyid").and_then(Value::as_str) else {
            continue;
        };
        if counted.contains(&keyid) {
            continue;
        }
        if root.revoked_key_ids.iter().any(|revoked| revoked == keyid) {
            return Err(CatalogError::new(
                RejectionReason::RevokedKey,
                role,
                format!("key {keyid} is revoked"),
            ));
        }
        if !spec.keyids.iter().any(|listed| listed == keyid) {
            continue;
        }
        let key = root.keys.get(keyid).ok_or_else(|| {
            CatalogError::new(
                RejectionReason::UnknownKey,
                role,
                "signature names no known key",
            )
        })?;
        if key.keytype != "ed25519" {
            return Err(malformed(
                role,
                format!("unsupported keytype {}", key.keytype),
            ));
        }
        let valid = (|| {
            let public = VerifyingKey::from_bytes(&decode_hex::<32>(&key.public_key)?).ok()?;
            let sig = decode_hex::<64>(signature.get("sig")?.as_str()?)?;
            public.verify(&message, &Signature::from_bytes(&sig)).ok()
        })();
        if valid.is_some() {
            counted.push(keyid);
        }
    }
    let threshold = spec.threshold as usize;
    if counted.len() < threshold {
        return Err(CatalogError::new(
            if counted.is_empty() {
                RejectionReason::Signature
            } else {
                RejectionReason::Threshold
            },
            role,
            format!(
                "{role} has {} valid signatures, needs {threshold}",
                counted.len()
            ),
        ));
    }
    Ok(())
}

fn role_doc(bundle: &Value, role: CatalogRole) -> Result<&Value, CatalogError> {
    bundle
        .get(role.as_str())
        .filter(|doc| doc.is_object())
        .ok_or_else(|| malformed(CatalogRole::Root, "catalog bundle is incomplete"))
}

fn signed_u64(doc: &Value, field: &str) -> Option<u64> {
    doc.get("signed")?.get(field)?.as_u64()
}

/// Verify a whole bundle and return the targets plus the advanced trust state
/// the caller must persist. Root first (it names every other key), then
/// timestamp (liveness), snapshot (pins targets), targets.
pub fn verify_signed_catalog(
    bundle: &Value,
    trust: &TrustState,
    now: DateTime<Utc>,
) -> Result<VerifiedCatalog, CatalogError> {
    let root_doc = role_doc(bundle, CatalogRole::Root)?;
    let timestamp = role_doc(bundle, CatalogRole::Timestamp)?;
    let snapshot = role_doc(bundle, CatalogRole::Snapshot)?;
    let targets = role_doc(bundle, CatalogRole::Targets)?;

    // A new root must be signed by the root already trusted.
    verify_role(
        CatalogRole::Root,
        root_doc,
        &trust.root,
        now,
        Some(trust.seen_versions.root.unwrap_or(trust.root.version)),
    )?;
    let root: RootPayload = serde_json::from_value(root_doc["signed"].clone())
        .map_err(|error| malformed(CatalogRole::Root, error.to_string()))?;

    verify_role(
        CatalogRole::Timestamp,
        timestamp,
        &root,
        now,
        trust.seen_versions.timestamp,
    )?;
    verify_role(
        CatalogRole::Snapshot,
        snapshot,
        &root,
        now,
        trust.seen_versions.snapshot,
    )?;
    let snapshot_version = signed_u64(snapshot, "version");
    if signed_u64(timestamp, "snapshotVersion") != snapshot_version {
        return Err(CatalogError::new(
            RejectionReason::SnapshotMismatch,
            CatalogRole::Snapshot,
            "timestamp points at a different snapshot version",
        ));
    }
    verify_role(
        CatalogRole::Targets,
        targets,
        &root,
        now,
        trust.seen_versions.targets,
    )?;
    let targets_payload: TargetsPayload = serde_json::from_value(targets["signed"].clone())
        .map_err(|error| malformed(CatalogRole::Targets, error.to_string()))?;
    if signed_u64(snapshot, "targetsVersion") != Some(targets_payload.version) {
        return Err(CatalogError::new(
            RejectionReason::SnapshotMismatch,
            CatalogRole::Targets,
            "snapshot pins a different targets version",
        ));
    }

    let seen_versions = SeenVersions {
        root: Some(root.version),
        timestamp: signed_u64(timestamp, "version"),
        snapshot: snapshot_version,
        targets: Some(targets_payload.version),
    };
    Ok(VerifiedCatalog {
        targets: targets_payload,
        trust: TrustState {
            root,
            seen_versions,
        },
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    pub(crate) const FIXTURE: &str =
        include_str!("../../../test-fixtures/updates/host-catalog.json");

    pub(crate) fn fixture() -> (Value, TrustState, DateTime<Utc>) {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture json");
        let root: RootPayload =
            serde_json::from_value(fixture["trustRoot"].clone()).expect("trust root");
        let now = DateTime::parse_from_rfc3339(fixture["now"].as_str().expect("now"))
            .expect("now")
            .with_timezone(&Utc);
        (fixture["bundle"].clone(), TrustState::new(root), now)
    }

    /// The fixture's seeds (`FIXTURE_SEEDS` in the signer): one per role.
    fn fixture_key(role: CatalogRole) -> SigningKey {
        let byte = match role {
            CatalogRole::Root => 0x11,
            CatalogRole::Targets => 0x22,
            CatalogRole::Snapshot => 0x33,
            CatalogRole::Timestamp => 0x44,
        };
        SigningKey::from_bytes(&[byte; 32])
    }

    fn resign(bundle: &mut Value, role: CatalogRole, key: &SigningKey) {
        let doc = &mut bundle[role.as_str()];
        let message = cognia_canonical_json::canonical_bytes(&doc["signed"]).expect("canonical");
        let keyid = doc["signatures"][0]["keyid"].clone();
        doc["signatures"] = json!([{
            "keyid": keyid,
            "sig": hex::encode(key.sign(&message).to_bytes()),
        }]);
    }

    #[test]
    fn the_offline_signers_bundle_verifies_here_as_in_the_app() {
        let (bundle, trust, now) = fixture();
        let verified = verify_signed_catalog(&bundle, &trust, now).expect("verified");
        assert_eq!(verified.targets.entries.len(), 8);
        assert_eq!(verified.trust.seen_versions.targets, Some(1));
        assert_eq!(verified.trust.seen_versions.root, Some(1));
        // The seeds the fixture was built from are the keys the root names.
        let targets_key = hex::encode(fixture_key(CatalogRole::Targets).verifying_key().as_bytes());
        assert!(trust
            .root
            .keys
            .values()
            .any(|key| key.public_key == targets_key));
    }

    #[test]
    fn an_altered_entry_fails_its_signature() {
        let (mut bundle, trust, now) = fixture();
        bundle["targets"]["signed"]["entries"][0]["sha256"] = json!("0".repeat(64));
        let error = verify_signed_catalog(&bundle, &trust, now).unwrap_err();
        assert_eq!(
            (error.reason, error.role),
            (RejectionReason::Signature, CatalogRole::Targets)
        );
    }

    #[test]
    fn a_field_this_build_does_not_know_is_still_covered() {
        let (mut bundle, trust, now) = fixture();
        bundle["targets"]["signed"]["entries"][0]["futureField"] = json!(true);
        assert_eq!(
            verify_signed_catalog(&bundle, &trust, now)
                .unwrap_err()
                .reason,
            RejectionReason::Signature
        );
    }

    #[test]
    fn an_older_targets_version_than_one_seen_is_a_rollback() {
        let (bundle, mut trust, now) = fixture();
        trust.seen_versions.targets = Some(2);
        let error = verify_signed_catalog(&bundle, &trust, now).unwrap_err();
        assert_eq!(
            (error.reason, error.role),
            (RejectionReason::Rollback, CatalogRole::Targets)
        );
    }

    #[test]
    fn expired_metadata_is_refused() {
        let (bundle, trust, _) = fixture();
        let later = DateTime::parse_from_rfc3339("2040-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            verify_signed_catalog(&bundle, &trust, later)
                .unwrap_err()
                .reason,
            RejectionReason::Expired
        );
    }

    #[test]
    fn a_revoked_key_refuses_whatever_it_signed() {
        let (mut bundle, trust, now) = fixture();
        let targets_keyid = trust.root.roles["targets"].keyids[0].clone();
        // Later roles verify against the bundle's own root, so the revocation
        // ships there: a higher root version, signed by the trusted root key.
        bundle["root"]["signed"]["revokedKeyIds"] = json!([targets_keyid]);
        bundle["root"]["signed"]["version"] = json!(2);
        resign(
            &mut bundle,
            CatalogRole::Root,
            &fixture_key(CatalogRole::Root),
        );
        let error = verify_signed_catalog(&bundle, &trust, now).unwrap_err();
        assert_eq!(
            (error.reason, error.role),
            (RejectionReason::RevokedKey, CatalogRole::Targets)
        );
    }

    #[test]
    fn a_new_root_must_be_signed_by_the_trusted_one() {
        let (mut bundle, trust, now) = fixture();
        bundle["root"]["signed"]["version"] = json!(2);
        resign(
            &mut bundle,
            CatalogRole::Root,
            &SigningKey::from_bytes(&[0x55; 32]),
        );
        let error = verify_signed_catalog(&bundle, &trust, now).unwrap_err();
        assert_eq!(
            (error.reason, error.role),
            (RejectionReason::Signature, CatalogRole::Root)
        );
        // Signed by the trusted root key, the same change is accepted and
        // becomes the new trust.
        resign(
            &mut bundle,
            CatalogRole::Root,
            &fixture_key(CatalogRole::Root),
        );
        let verified = verify_signed_catalog(&bundle, &trust, now).expect("rotated");
        assert_eq!(verified.trust.root.version, 2);
    }

    #[test]
    fn a_snapshot_must_pin_the_targets_it_ships_with() {
        let (mut bundle, trust, now) = fixture();
        bundle["snapshot"]["signed"]["targetsVersion"] = json!(9);
        resign(
            &mut bundle,
            CatalogRole::Snapshot,
            &fixture_key(CatalogRole::Snapshot),
        );
        let error = verify_signed_catalog(&bundle, &trust, now).unwrap_err();
        assert_eq!(
            (error.reason, error.role),
            (RejectionReason::SnapshotMismatch, CatalogRole::Targets)
        );

        let (mut bundle, trust, now) = fixture();
        bundle["timestamp"]["signed"]["snapshotVersion"] = json!(9);
        resign(
            &mut bundle,
            CatalogRole::Timestamp,
            &fixture_key(CatalogRole::Timestamp),
        );
        assert_eq!(
            verify_signed_catalog(&bundle, &trust, now)
                .unwrap_err()
                .reason,
            RejectionReason::SnapshotMismatch
        );
    }

    #[test]
    fn a_document_of_the_wrong_role_or_shape_is_refused() {
        let (mut bundle, trust, now) = fixture();
        bundle["snapshot"]["signed"]["_type"] = json!("targets");
        assert_eq!(
            verify_signed_catalog(&bundle, &trust, now)
                .unwrap_err()
                .reason,
            RejectionReason::RoleMismatch
        );
        assert_eq!(
            verify_signed_catalog(&json!({}), &trust, now)
                .unwrap_err()
                .reason,
            RejectionReason::Malformed
        );
    }

    #[test]
    fn a_trust_root_parses_from_json_or_its_base64_env_form() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        let json = fixture["trustRoot"].to_string();
        let root = parse_trust_root(&json).expect("json root");
        let encoded = base64::engine::general_purpose::STANDARD.encode(json.as_bytes());
        assert_eq!(parse_trust_root(&encoded), Some(root));
        assert_eq!(parse_trust_root(""), None);
        assert_eq!(parse_trust_root("{\"_type\":\"targets\"}"), None);
        assert_eq!(parse_trust_root("not base64 !"), None);
    }
}
