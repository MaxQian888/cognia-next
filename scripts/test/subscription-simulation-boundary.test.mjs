import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"

import { createSubscriptionSimulationBoundary } from "./subscription-simulation-boundary.mjs"

let temporaryRoot

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "cognia-subscription-simulation-"))
})

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

test("injects isolated provider homes without reading the process environment", () => {
  const boundary = createSubscriptionSimulationBoundary(temporaryRoot)

  for (const [key, path] of Object.entries(boundary.environment)) {
    assert.ok(key.length > 0)
    assert.match(path, new RegExp(`^${escapeRegExp(boundary.temporaryRoot)}/`))
    mkdirSync(path, { recursive: true })
    assert.equal(boundary.assertTemporaryPath(path), path)
  }
})

test("fails closed for real paths, OS credential stores, and public endpoints", () => {
  const boundary = createSubscriptionSimulationBoundary(temporaryRoot)

  assert.throws(() => boundary.assertTemporaryPath("/Users/example/.codex"), /non-temporary path/)
  assert.throws(() => boundary.assertTemporaryPath(temporaryRoot), /non-temporary path/)
  assert.throws(() => boundary.assertCredentialAdapter("macos-keychain"), /credential adapter/)
  assert.throws(
    () => boundary.assertFixtureEndpoint("https://auth.openai.com/oauth/token"),
    /public network/
  )
  assert.equal(boundary.assertCredentialAdapter("memory"), "memory")
  assert.match(
    boundary.assertFixtureEndpoint("http://127.0.0.1:43123/token"),
    /^http:\/\/127\.0\.0\.1/
  )
  assert.equal(boundary.assertFixtureEndpoint("in-process:codex-oauth"), "in-process:codex-oauth")
})

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
