//! Reusable engines: the type-appropriate build/pack pipeline, Ed25519
//! signing, the desktop CLI-bridge HTTP client, the scaffold templates, the
//! generated plugin contract, and the embedded release-signing key. Each is
//! consumed by one or more command handlers in `commands/` and carries no CLI
//! surface of its own.

pub(crate) mod bridge_client;
// RFC 8785 canonical JSON — the signing-side twin of
// lib/plugin/character-pack/canonical-json.ts. Both are driven by one shared
// golden-vector fixture so they cannot silently diverge.
pub(crate) mod canonical_json;
pub(crate) mod contract;
pub(crate) mod frontend_build;
pub(crate) mod packaging;
// Source of truth for the release-signing public key. Mirrored into
// src-tauri + the renderer by scripts/release-sync-keys.mjs.
pub(crate) mod release_key;
pub(crate) mod signing;
pub(crate) mod template;
