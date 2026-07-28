//! Record-and-replay skill recorder.
//!
//! Observes desktop interactions (clicks / key runs / scrolls) during a
//! consented session, enriching each with a screenshot + the accessibility
//! element under the cursor (reusing the automation worker), and returns a
//! coarse `RecordingTrace`. The renderer turns the trace into a generated Skill
//! via an LLM (`lib/skills/generate-from-trace.ts`). Replay is agentic via the
//! existing computer-use tools — this is not a deterministic event recorder.
//!
//! The global input hook is implemented for Windows (`hook_win`, low-level
//! `WH_*` hooks) and macOS (`hook_mac`, CGEventTap — needs Accessibility /
//! Input Monitoring permission); other platforms degrade gracefully
//! (`hook_stub` returns Unsupported).

pub mod commands;
pub mod session;
