//! Signing catalogs in tests, with the conformance fixture's keys
//! (`FIXTURE_SEEDS` in `scripts/release/update-catalog.mjs`).

use chrono::{DateTime, Utc};
use ed25519_dalek::{Signer as _, SigningKey};
use serde_json::{json, Value};

use crate::verify::RootPayload;

fn key(role: &str) -> SigningKey {
    let byte = match role {
        "root" => 0x11,
        "targets" => 0x22,
        "snapshot" => 0x33,
        _ => 0x44,
    };
    SigningKey::from_bytes(&[byte; 32])
}

/// Any stable id works here: the verifier only matches ids against the root.
fn keyid(key: &SigningKey) -> String {
    hex::encode(key.verifying_key().as_bytes())
}

fn sign(role: &str, payload: &Value) -> Value {
    let message = cognia_canonical_json::canonical_bytes(payload).expect("canonical");
    let key = key(role);
    json!({
        "signed": payload,
        "signatures": [{ "keyid": keyid(&key), "sig": hex::encode(key.sign(&message).to_bytes()) }],
    })
}

/// The trusted root naming the fixture keys.
pub fn root() -> RootPayload {
    serde_json::from_value(root_payload()).expect("root")
}

fn root_payload() -> Value {
    let mut keys = serde_json::Map::new();
    let mut roles = serde_json::Map::new();
    for role in ["root", "targets", "snapshot", "timestamp"] {
        let key = key(role);
        let id = keyid(&key);
        keys.insert(
            id.clone(),
            json!({ "keyid": id, "keytype": "ed25519", "publicKey": hex::encode(key.verifying_key().as_bytes()) }),
        );
        roles.insert(role.to_owned(), json!({ "keyids": [id], "threshold": 1 }));
    }
    json!({ "_type": "root", "version": 1, "expires": "2036-01-01T00:00:00Z", "keys": keys, "roles": roles })
}

/// A complete signed bundle listing `entries`, every role at `version`.
pub fn sign_bundle(entries: Vec<Value>, version: u64, now: DateTime<Utc>) -> Value {
    let expires = (now + chrono::Duration::days(30)).to_rfc3339();
    let targets =
        json!({ "_type": "targets", "version": version, "expires": expires, "entries": entries });
    let snapshot = json!({ "_type": "snapshot", "version": version, "expires": expires, "targetsVersion": version });
    let timestamp = json!({ "_type": "timestamp", "version": version, "expires": expires, "snapshotVersion": version });
    json!({
        "root": sign("root", &root_payload()),
        "targets": sign("targets", &targets),
        "snapshot": sign("snapshot", &snapshot),
        "timestamp": sign("timestamp", &timestamp),
    })
}

/// The two entries of one host release.
pub fn host_release_entries(
    version: &str,
    channel: &str,
    target: &str,
    artifact: Value,
) -> Vec<Value> {
    let common = json!({
        "assetId": "host",
        "executor": "cognia-host",
        "version": version,
        "channel": channel,
        "criticality": "routine",
        "releasedAt": "2026-10-11T00:00:00Z",
        "target": target,
        "contractVersion": 3,
        "catalogHash": "c".repeat(64),
    });
    let mut server = common.clone();
    server["kind"] = json!("host-server");
    for (field, value) in artifact.as_object().expect("artifact object") {
        server[field] = value.clone();
    }
    let mut brain = common;
    brain["kind"] = json!("host-brain");
    vec![server, brain]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::verify::{verify_signed_catalog, TrustState};

    #[test]
    fn a_signed_test_bundle_verifies() {
        let now = Utc::now();
        let bundle = sign_bundle(
            host_release_entries(
                "2.0.0",
                "stable",
                "darwin-arm64",
                json!({ "url": "https://x/a.tar.gz", "sha256": "a".repeat(64) }),
            ),
            3,
            now,
        );
        let verified =
            verify_signed_catalog(&bundle, &TrustState::new(root()), now).expect("verifies");
        assert_eq!(verified.targets.entries.len(), 2);
    }
}
