//! `.claude/settings.json` readers and writers live in
//! `cognia_hooks::settings` (ADR-0196 P6c), re-exported here so
//! `generate_handler!`'s `settings::…` paths resolve unchanged.

pub use cognia_hooks::settings::*;
