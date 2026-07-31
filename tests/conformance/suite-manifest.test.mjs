// Suite-identity pinning (ADR-0090 Phase 5): the frozen case list, its hash,
// and the scenario registry must move TOGETHER with SUITE_VERSION bumps.

import test from "node:test"
import assert from "node:assert/strict"

import {
  computeSuiteHash,
  scenarioRegistryIds,
  SUITE_CASES,
  SUITE_CASES_SHA256,
  SUITE_VERSION,
} from "./suite-manifest.mjs"

test("the frozen case list hash matches the recorded SUITE_CASES_SHA256", () => {
  assert.equal(
    computeSuiteHash(SUITE_CASES),
    SUITE_CASES_SHA256,
    `case list changed — bump SUITE_VERSION (currently ${SUITE_VERSION}) and re-pin the hash`
  )
})

test("every frozen case exists in the scenario registry and vice versa", () => {
  assert.deepEqual([...SUITE_CASES].sort(), scenarioRegistryIds())
})

test("suite version is a non-empty stable string", () => {
  assert.match(SUITE_VERSION, /^\d+$/)
})
