//! The signed update catalog (ADR-0224 A10).
//!
//! Cognia's update catalog is a TUF-style bundle: a `root` that names one key
//! set per role, a short-lived `timestamp`, a `snapshot` that pins the
//! targets version, and `targets` listing the releases. An offline tool signs
//! it (`scripts/release/update-catalog.mjs`), the update Worker only stores
//! it, and every client verifies it against a root it shipped with. The app
//! verifies in TypeScript (`lib/updates/catalog-verify.ts`); an always-on host
//! verifies here, before it installs anything.
//!
//! * [`verify`] is the port of the client's verification: signature
//!   thresholds per role, expiry, monotonic versions (the rollback gate),
//!   revoked keys, and the timestamp → snapshot → targets chain. All three
//!   implementations are pinned to one fixture,
//!   `test-fixtures/updates/host-catalog.json`.
//! * [`host_release`] picks the release a host may install from verified
//!   entries. A host release is a `host-server` entry (the archive or image)
//!   paired with a `host-brain` entry of the same version naming the same
//!   contract; an unpaired or split release is never offered, which is the
//!   catalog-level twin of the half-updated host A10a refuses at runtime.
//!
//! Nothing here does I/O or reads the clock: callers pass `now`.

pub mod host_release;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
pub mod verify;

pub use host_release::{
    compare_versions, host_releases, select_host_release, HostArtifact, HostRelease,
    HostReleaseQuery, HOST_ASSET_ID,
};
pub use verify::{
    parse_trust_root, verify_signed_catalog, CatalogEntry, CatalogError, CatalogRole,
    RejectionReason, Rollout, RootPayload, SeenVersions, TargetsPayload, TrustState,
    VerifiedCatalog,
};
