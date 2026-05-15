//! Cross-platform automation helpers — the parts that don't depend on a
//! platform-specific accessibility API. Currently:
//!
//!   - `screenshot` — xcap-based monitor capture. The same code drives the
//!     Windows UIA backend and the macOS / Linux minimum-viable backends.

pub mod screenshot;
