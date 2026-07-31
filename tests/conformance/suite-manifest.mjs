// Versioned conformance-suite identity (ADR-0090 Phase 5).
//
// SUITE_VERSION participates in every CompatibilityRecordKey: certifications
// go stale the moment the suite changes. To make that non-gameable, the
// frozen ordered case list is hashed and `suite-manifest.test.mjs` fails
// whenever the scenario registry drifts without a version bump.

import { createHash } from "node:crypto"

import { SCENARIOS } from "./anthropic-server/scenarios/index.mjs"

export const SUITE_VERSION = "1"

/** Frozen, ordered case list for SUITE_VERSION 1. Append-only per version. */
export const SUITE_CASES = [
  "text-sse",
  "multi-turn",
  "tools",
  "fragmented-json",
  "permission",
  "model-binding",
  "rate-limit",
  "upstream-5xx",
  "stream-interruption",
  "sticky-failover",
]

/** Hash of the frozen list — recorded here, asserted by the test. */
export const SUITE_CASES_SHA256 = "c3112b582dd0052d5900e19550faa037aca7b257f6c80d1c1b273e28842ec534"

export function computeSuiteHash(cases = SUITE_CASES) {
  return createHash("sha256").update(JSON.stringify(cases)).digest("hex")
}

export function scenarioRegistryIds() {
  return Object.keys(SCENARIOS).sort()
}
