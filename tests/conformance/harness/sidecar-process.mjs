// Real-sidecar spawner for conformance cases (ADR-0090 Phase 4).
//
// Re-exports the shared live harness (`sidecar/dispatch/live-harness.mjs`):
// the REAL sidecar entry, the REAL @anthropic-ai/claude-agent-sdk and the
// claude-code subprocess it spawns, driven over the same stdio JSON-line
// protocol the Tauri/headless hosts use. One spawn contract, consumed by both
// the sidecar live tests and this suite, so the two can never drift.

export {
  spawnSidecar,
  assistantText,
  startMockAnthropic,
} from "../../../sidecar/dispatch/live-harness.mjs"
