//! The companion's wire contract as compiled into the host (ADR-0175,
//! ADR-0196 P4).
//!
//! - [`command_manifest`] — every command descriptor, rendered from
//!   `protocol/companion-commands.json` into `generated/known_commands.rs` by
//!   `scripts/build/gen-companion-api.mjs`, plus the embedded Headless
//!   contract the host validates inputs and outputs against.
//! - [`settings_sync_generated`] — which `AppSettings` fields a paired client
//!   may write back, rendered by `scripts/build/gen-settings-sync.mjs`.
//! - [`paging`] — the page token and page envelope every list answers with.
//!
//! Both generators write here and check here (`--check`); the gates find these
//! paths through `scripts/gates/lib/companion-source-paths.mjs`. The desktop
//! re-exports each module at its old `companion_api::<module>` path.

pub mod command_manifest;
pub mod paging;
pub mod settings_sync_generated;
