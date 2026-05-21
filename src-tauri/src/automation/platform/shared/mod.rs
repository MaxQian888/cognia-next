//! Cross-platform automation helpers — the parts that don't depend on a
//! platform-specific accessibility API. Currently:
//!
//!   - `screenshot` — xcap-based monitor capture. The same code drives the
//!     Windows UIA backend and the macOS / Linux minimum-viable backends.
//!   - `credential_window` — focus-window credential-prompt detection used
//!     by the W1 screenshot redaction path.

pub mod credential_window;
pub mod screenshot;
