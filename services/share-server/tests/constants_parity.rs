//! Constants-parity gate against the committed canonical fixture
//! `share-constants.json` (ADR-0059 P0.3).
//!
//! The Rust axum server and the TypeScript Cloudflare Worker each declare the
//! share-code and limit constants as literals. This test pins the Rust side to
//! the fixture; `worker/src/constants-parity.test.ts` pins the Worker side.
//! Drift on either side fails that side's CI instead of shipping silently.
//! `kvMinTtlSeconds` is a Cloudflare KV platform constraint with no Rust
//! equivalent — asserted only by the Worker test.

use cognia_share_server::blobs::{
    BLOB_CHUNK_BYTES, BLOB_CHUNK_OVERHEAD_BYTES, BLOB_ID_BYTES, MAX_BLOBS_PER_SHARE,
    MAX_BLOB_BYTES, MAX_SHARE_BLOB_BYTES, READ_TICKET_TTL_SECONDS,
};
use cognia_share_server::codegen::{CODE_ALPHABET, CODE_LENGTH};
use cognia_share_server::server::{
    DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_TTL_SECONDS, PUBLIC_METADATA_SUFFIX,
};
use cognia_share_server::store::PUBLIC_METADATA_FIELDS;
use serde_json::Value;

const FIXTURE: &str = include_str!("../share-constants.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("share-constants.json is valid JSON")
}

#[test]
fn code_length_matches_fixture() {
    assert_eq!(
        fixture()["codeLength"]
            .as_u64()
            .expect("codeLength is a number"),
        CODE_LENGTH as u64,
    );
}

#[test]
fn code_alphabet_matches_fixture() {
    let expected = fixture();
    let expected = expected["codeAlphabet"]
        .as_str()
        .expect("codeAlphabet is a string");
    let actual = std::str::from_utf8(CODE_ALPHABET).expect("alphabet is ASCII");
    assert_eq!(expected, actual);
}

#[test]
fn default_max_body_bytes_matches_fixture() {
    assert_eq!(
        fixture()["defaultMaxBodyBytes"]
            .as_u64()
            .expect("defaultMaxBodyBytes is a number"),
        DEFAULT_MAX_BODY_BYTES as u64,
    );
}

#[test]
fn default_max_ttl_seconds_matches_fixture() {
    assert_eq!(
        fixture()["defaultMaxTtlSeconds"]
            .as_u64()
            .expect("defaultMaxTtlSeconds is a number"),
        DEFAULT_MAX_TTL_SECONDS,
    );
}

#[test]
fn blob_limits_match_fixture() {
    let value = fixture();
    let number = |key: &str| {
        value[key]
            .as_u64()
            .unwrap_or_else(|| panic!("{key} is a number"))
    };
    assert_eq!(number("blobChunkBytes"), BLOB_CHUNK_BYTES);
    assert_eq!(number("blobChunkOverheadBytes"), BLOB_CHUNK_OVERHEAD_BYTES);
    assert_eq!(number("blobIdBytes"), BLOB_ID_BYTES as u64);
    assert_eq!(number("maxBlobBytes"), MAX_BLOB_BYTES);
    assert_eq!(number("maxShareBlobBytes"), MAX_SHARE_BLOB_BYTES);
    assert_eq!(number("maxBlobsPerShare"), MAX_BLOBS_PER_SHARE);
    assert_eq!(number("readTicketTtlSeconds"), READ_TICKET_TTL_SECONDS);
}

#[test]
fn fixture_has_no_unknown_numeric_drift_fields() {
    // Guard the fixture's shape so a renamed key can't silently decouple the
    // two suites: every key either maps to a Rust assertion above or is the
    // documented Worker-only kvMinTtlSeconds / _comment.
    let value = fixture();
    let object = value.as_object().expect("fixture is an object");
    let known = [
        "_comment",
        "codeLength",
        "codeAlphabet",
        "defaultMaxBodyBytes",
        "defaultMaxTtlSeconds",
        "kvMinTtlSeconds",
        "blobChunkBytes",
        "blobChunkOverheadBytes",
        "blobIdBytes",
        "maxBlobBytes",
        "maxShareBlobBytes",
        "maxBlobsPerShare",
        "readTicketTtlSeconds",
        "publicMetadataSuffix",
        "publicMetadataFields",
    ];
    for key in object.keys() {
        assert!(known.contains(&key.as_str()), "unknown fixture key: {key}");
    }
    for key in &known {
        assert!(object.contains_key(*key), "fixture missing key: {key}");
    }
}

#[test]
fn public_metadata_contract_matches_fixture() {
    assert_eq!(fixture()["publicMetadataSuffix"], PUBLIC_METADATA_SUFFIX);
    assert_eq!(
        fixture()["publicMetadataFields"],
        serde_json::json!(PUBLIC_METADATA_FIELDS)
    );
}
