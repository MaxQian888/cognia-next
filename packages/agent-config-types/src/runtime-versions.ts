// Pinned runtime versions (ADR-0090 Phase 5).
//
// The single source the staleness computation trusts for "what is installed
// right now". `scripts/gates/check-runtime-versions.mjs` fails the build when
// these constants drift from the actual pins (`sidecar/package.json`'s exact
// Agent SDK version, `crates/cognia-gateway/Cargo.toml`'s crate version) —
// without that gate, staleness would be theater.

export const PINNED_RUNTIME_VERSIONS = {
  /** Exact @anthropic-ai/claude-agent-sdk pin in sidecar/package.json. */
  agentSdkVersion: "0.3.220",
  /** crates/cognia-gateway Cargo.toml package version. */
  gatewayCrateVersion: "0.1.0",
} as const

export type PinnedRuntimeVersions = typeof PINNED_RUNTIME_VERSIONS
