//! The share service and `crates/cognia-tenant-auth` must agree on the grant
//! wire format — ADR-0149 §8.
//!
//! This service verifies grants with its own implementation
//! (`cognia_share_core::grant`) because `.github/workflows/images.yml` builds
//! it with `context: services/share-server`: a `path = "../../crates/…"`
//! dependency resolves under `cargo test` and then fails inside Docker, where
//! the parent directory does not exist.
//!
//! Duplicated code that nothing pins drifts. The drift would be invisible
//! until grants the collaboration server mints started being rejected here —
//! in production, reported as "sharing stopped working".
//!
//! So both sides verify the same frozen bytes. The fixture lives beside the
//! crate that owns the format; a *test* may read across the repository even
//! though a dependency may not, because tests never run inside the image.

use std::path::PathBuf;

use cognia_share_core::grant::{GrantError, GrantVerifier};

fn vector() -> serde_json::Value {
    // Two hops up from this crate's manifest directory: the fixture belongs to
    // the owning crate, not to a copy kept here that could be edited alone.
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../crates/cognia-tenant-auth/fixtures/grant-wire-vector.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "the frozen grant vector must be readable at {}: {error}. \
             It is the only thing keeping these two implementations in step — \
             do not delete it, and do not copy it into this directory.",
            path.display()
        )
    });
    serde_json::from_str(&raw).expect("fixture is json")
}

fn hex_bytes(value: &str) -> Vec<u8> {
    assert!(value.len() % 2 == 0, "hex must be even length");
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).expect("hex"))
        .collect()
}

#[test]
fn a_grant_minted_by_the_collaboration_server_verifies_here() {
    let vector = vector();
    let verifier =
        GrantVerifier::new(&hex_bytes(vector["keyHex"].as_str().expect("keyHex"))).expect("key");
    let claims = verifier
        .verify(
            vector["token"].as_str().expect("token"),
            vector["verifyAtUnix"].as_i64().expect("verifyAtUnix"),
        )
        .expect("the frozen vector must verify");

    assert_eq!(claims.org_id, "org_acmecorporation000001");
    assert_eq!(claims.user_id, "usr_adalovelace000000000001");
}

#[test]
fn the_same_grant_is_refused_once_it_expires() {
    let vector = vector();
    let verifier =
        GrantVerifier::new(&hex_bytes(vector["keyHex"].as_str().expect("keyHex"))).expect("key");
    assert_eq!(
        verifier.verify(
            vector["token"].as_str().expect("token"),
            vector["expiredAtUnix"].as_i64().expect("expiredAtUnix"),
        ),
        Err(GrantError::Expired)
    );
}
