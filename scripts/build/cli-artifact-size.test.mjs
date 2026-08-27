import assert from "node:assert/strict"
import test from "node:test"

import { assertCliArtifactSizes } from "./cli-artifact-size.mjs"

function report({ full = 120_000_000, slim = 37_000_000 } = {}) {
  return {
    target: "darwin-arm64",
    variants: {
      full: { archiveBytes: full },
      slim: { archiveBytes: slim },
    },
  }
}

test("accepts archives meeting reduction, macOS cap, and full baseline guards", () => {
  const value = report()
  assert.equal(assertCliArtifactSizes(value), value)
  assert.ok(value.comparison.slimReductionRatio >= 0.65)
})

test("rejects a slim archive that is less than 65% smaller", () => {
  assert.throws(
    () => assertCliArtifactSizes(report({ full: 120_000_000, slim: 45_000_000 })),
    /at least 65%/
  )
})

test("rejects macOS slim archives above 38 MiB", () => {
  assert.throws(
    () => assertCliArtifactSizes(report({ full: 150_000_000, slim: 40_000_000 })),
    /38 MiB/
  )
})

test("rejects a macOS full archive that regresses over 1%", () => {
  assert.throws(
    () => assertCliArtifactSizes(report({ full: 130_000_000, slim: 30_000_000 })),
    /more than 1%/
  )
})

test("allows single-variant reports without inventing a comparison", () => {
  const value = { target: "linux-x64", variants: { slim: { archiveBytes: 30_000_000 } } }
  assert.equal(assertCliArtifactSizes(value), value)
  assert.equal(value.comparison, undefined)
})
