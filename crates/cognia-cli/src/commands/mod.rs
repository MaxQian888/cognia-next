//! One module per `cognia` subcommand. Each exposes a `run(...)` entry point
//! invoked by the dispatcher in [`crate::cli`]; cross-command reuse (e.g.
//! `build` calling `lint::validate_at`, `dev` calling `build`) goes through
//! these modules' public items rather than duplicating logic.

pub(crate) mod acp;
pub(crate) mod build;
pub(crate) mod crash;
pub(crate) mod dev;
pub(crate) mod diagnostic_common;
pub(crate) mod doctor;
pub(crate) mod embed_version;
pub(crate) mod import;
pub(crate) mod info;
pub(crate) mod install;
pub(crate) mod keygen;
pub(crate) mod lint;
pub(crate) mod list;
pub(crate) mod logs;
pub(crate) mod new;
pub(crate) mod release_key;
pub(crate) mod release_verify;
pub(crate) mod reload;
pub(crate) mod sign;
pub(crate) mod status;
pub(crate) mod sync_types;
pub(crate) mod uninstall;
pub(crate) mod verify;
