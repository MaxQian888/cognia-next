//! Record-and-replay skill recorder.
//!
//! Observes desktop interactions (clicks / key runs / scrolls) during a
//! consented session, enriching each with a screenshot + the accessibility
//! element under the cursor (reusing the automation worker), and returns a
//! coarse `RecordingTrace`. The renderer turns the trace into a generated Skill
//! via an LLM (`lib/skills/generate-from-trace.ts`). Replay is agentic via the
//! existing computer-use tools — this is not a deterministic event recorder.
//!
//! Windows-first: the global input hook is implemented for Windows; other
//! platforms degrade gracefully (`hook_stub` returns Unsupported).

pub mod commands;
pub mod session;

#[cfg(target_os = "windows")]
mod hook_win;
#[cfg(target_os = "windows")]
pub(crate) use hook_win::HookGuard;

#[cfg(not(target_os = "windows"))]
mod hook_stub;
#[cfg(not(target_os = "windows"))]
pub(crate) use hook_stub::HookGuard;
