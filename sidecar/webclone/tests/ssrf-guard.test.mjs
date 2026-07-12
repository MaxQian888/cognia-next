// Tests for the vendored engine's SSRF guard. Imports the BUILT output so the
// suite exercises exactly what ships (run `npm run build` first — the sidecar
// build script does this in CI).

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  evaluateFetchTarget,
  assertFetchTargetAllowed,
  isPrivateOrLocalHost,
  FetchTargetBlockedError,
  setSsrfPolicy,
  getSsrfPolicy,
  guardOutboundUrl,
} from "../dist/ssrf-guard.js"

test("evaluateFetchTarget allows public https hosts", () => {
  const d = evaluateFetchTarget("https://example.com/page")
  assert.equal(d.allowed, true)
  assert.equal(d.reason, "ok")
  assert.equal(d.host, "example.com")
})

test("evaluateFetchTarget rejects non-http(s) schemes", () => {
  for (const url of ["file:///etc/passwd", "gopher://x", "data:text/html,x", "ftp://h/"]) {
    const d = evaluateFetchTarget(url)
    assert.equal(d.allowed, false, url)
    assert.equal(d.reason, "bad-scheme", url)
  }
})

test("evaluateFetchTarget rejects unparseable URLs", () => {
  const d = evaluateFetchTarget("not a url")
  assert.equal(d.allowed, false)
  assert.equal(d.reason, "bad-url")
})

test("evaluateFetchTarget blocks private / loopback / metadata ranges", () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://localhost/",
    "http://sub.localhost/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://100.64.0.1/", // CGNAT
    "http://[::1]/", // IPv6 loopback
    "http://[fe80::1]/", // IPv6 link-local
    "http://2130706433/", // decimal-encoded 127.0.0.1
    "http://0.0.0.0/",
  ]
  for (const url of blocked) {
    const d = evaluateFetchTarget(url)
    assert.equal(d.allowed, false, `${url} should be blocked`)
    assert.equal(d.reason, "private-host", url)
  }
})

test("evaluateFetchTarget honours allowPrivateHosts opt-in", () => {
  const d = evaluateFetchTarget("http://127.0.0.1/", { allowPrivateHosts: true })
  assert.equal(d.allowed, true)
})

test("isPrivateOrLocalHost handles ipv4-mapped ipv6 and empty host", () => {
  assert.equal(isPrivateOrLocalHost("::ffff:127.0.0.1"), true)
  assert.equal(isPrivateOrLocalHost(""), true)
  assert.equal(isPrivateOrLocalHost("example.com"), false)
})

test("assertFetchTargetAllowed throws FetchTargetBlockedError with reason", () => {
  try {
    assertFetchTargetAllowed("http://169.254.169.254/")
    assert.fail("should have thrown")
  } catch (err) {
    assert.ok(err instanceof FetchTargetBlockedError)
    assert.equal(err.reason, "private-host")
    assert.equal(err.host, "169.254.169.254")
  }
  // Public host does not throw.
  assert.doesNotThrow(() => assertFetchTargetAllowed("https://example.com/"))
})

test("module policy: setSsrfPolicy toggles guardOutboundUrl", () => {
  setSsrfPolicy({ allowPrivateHosts: false })
  assert.deepEqual(getSsrfPolicy(), { allowPrivateHosts: false })
  assert.throws(() => guardOutboundUrl("http://127.0.0.1/"), FetchTargetBlockedError)

  setSsrfPolicy({ allowPrivateHosts: true })
  assert.deepEqual(getSsrfPolicy(), { allowPrivateHosts: true })
  assert.doesNotThrow(() => guardOutboundUrl("http://127.0.0.1/"))

  // Reset so other suites in the same process start from the safe default.
  setSsrfPolicy({ allowPrivateHosts: false })
})
