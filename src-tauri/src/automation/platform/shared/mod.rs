//! Cross-platform automation helpers — the parts that don't depend on a
//! platform-specific accessibility API. Currently:
//!
//!   - `screenshot` — xcap-based monitor capture. The same code drives the
//!     Windows UIA backend and the macOS / Linux minimum-viable backends.
//!   - `credential_window` — focus-window credential-prompt detection used
//!     by the W1 screenshot redaction path.
//!   - `keymap` — backend-agnostic key chord parser used by the macOS /
//!     Linux enigo backends (W2). Windows UIA keeps its native parser
//!     but validates chords through this module too.

pub mod credential_window;
// ADR-0020 W2 — keymap is consumed by the macOS / Linux backends (and
// by tests on every platform). Gating it out of the Windows lib build
// avoids "never used" warnings on the Windows-only target without
// excluding the module from the test binary.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
pub mod keymap;
pub mod screenshot;
// KEY=value line parser for shell-tool output (`xdotool --shell`). Only
// the Linux backend consumes it in production; compiled with tests
// everywhere so the parser stays covered on the Windows dev host.
#[cfg(any(target_os = "linux", test))]
pub mod shell_vars;
