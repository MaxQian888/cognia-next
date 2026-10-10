//! Live file grants for a conversation's FileSpace (ADR-0222 §4–§5, P2).
//!
//! A snapshot share (P1) is a blind, encrypted copy; a **live grant** is an
//! authorization, held on the machine that has the files, for continuous
//! access to some paths of one conversation. This crate owns everything that
//! makes such a grant safe to serve:
//!
//! - [`store`] — `file-share.sqlite` per local account: the mount table the
//!   WebView or headless brain pushes, grants and their paths, credentials,
//!   persisted auth backoff, the policy snapshot, provider settings and a
//!   durable audit log.
//! - [`mounts`] — validating a pushed mount table and fingerprinting each
//!   mount, so a grant notices when its mount now points somewhere else.
//! - [`policy`] — the effective file-sharing policy pushed from TS (local ∩
//!   org) and the clamp it applies to grants.
//! - [`grants`] — creating, revoking, suspending, resuming and expiring
//!   grants, and issuing credentials ([`credentials`], [`backoff`]).
//! - [`gateway`] — the one authority every live operation goes through: the
//!   grant, the mount, the policy at its current revision, path confinement
//!   through `cognia-files`, and a sensitive-file floor no grant overrides.
//! - [`builtin`] — the built-in provider: a WebDAV listener (`dav-server`) and
//!   an SFTP listener (`russh` + `russh-sftp`, subsystem only).
//! - [`sftpgo`] — the optional SFTPGo provider for server deployments.
//! - [`listener`] — starting, exposing (loopback, LAN, tunnel) and stopping
//!   the built-in listeners, and dropping a revoked grant's connections.
//! - [`service`] — the process-wide facade the host installs once and the
//!   command shells ([`commands`]) and the companion RPC call into.
//!
//! The host injects what this crate cannot reach from its layer: an
//! [`assets::AssetReader`] that reads Dexie-backed mounts (`/uploads`,
//! `/artifacts`) through the renderer or brain bridge, a
//! [`mounts::MountSource`] that asks the same bridge for a conversation's
//! mount table when the service needs it fresh, a root validator that says
//! which host directories a mount may point at, and the unlocked account
//! ([`FileShareService::bind_account`]), which only the host's own account
//! session may set.

pub mod assets;
pub mod audit;
pub mod backoff;
pub mod builtin;
pub mod credentials;
pub mod error;
pub mod gateway;
pub mod grants;
pub mod listener;
pub mod model;
pub mod mounts;
pub mod page;
pub mod paths;
pub mod policy;
pub mod rpc;
pub mod service;
pub mod sftpgo;
pub mod store;

#[cfg(feature = "tauri-host")]
pub mod commands;

pub use error::{FileShareError, FileShareResult};
pub use service::FileShareService;

/// Milliseconds since the Unix epoch, the timestamp unit of every table here.
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_wall_clock_milliseconds() {
        let before = now_ms();
        // Past 2020-01-01 in milliseconds, so not seconds and not the zero fallback.
        assert!(before > 1_577_836_800_000);
        assert!(now_ms() >= before);
    }
}
