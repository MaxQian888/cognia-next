//! The headless Host's own modules (ADR-0196 P9).
//!
//! Everything else `cognia-server` runs lives in the companion crates; these
//! two exist only for this binary: [`brain`] supervises the Node brain
//! (`cognia-agent serve`), and [`tenant_lease`] keeps one server per
//! tenant-owned data volume.

pub mod brain;
pub mod tenant_lease;

/// P5 server-only person lifecycle; companion owns the dispatch boundary.
pub mod persons;
