import test from "node:test"
import { strict as assert } from "node:assert"

import {
  fingerprintToPinDigest,
  main,
  normaliseFingerprint,
  resolveFingerprint,
  rewritePinSet,
} from "./inject-server-fingerprint.mjs"

const VALID_FP = "ab".repeat(32) // 64 lower-case hex chars = 32 bytes

test("normaliseFingerprint accepts plain lower-case hex", () => {
  assert.equal(normaliseFingerprint(VALID_FP), VALID_FP)
})

test("normaliseFingerprint strips whitespace and colons", () => {
  const spaced = "AB:cd:".repeat(16)
  const cleaned = normaliseFingerprint(spaced + "\n")
  assert.equal(cleaned, "abcd".repeat(16))
})

test("normaliseFingerprint rejects wrong length", () => {
  assert.equal(normaliseFingerprint("abcd"), null)
  assert.equal(normaliseFingerprint("ab".repeat(33)), null)
})

test("normaliseFingerprint rejects non-hex chars", () => {
  assert.equal(normaliseFingerprint("xx".repeat(32)), null)
})

test("normaliseFingerprint rejects non-string", () => {
  assert.equal(normaliseFingerprint(undefined), null)
  assert.equal(normaliseFingerprint(123), null)
})

test("resolveFingerprint reads --fingerprint flag first", async () => {
  const fp = await resolveFingerprint(
    ["--fingerprint", VALID_FP],
    { COGNIA_PIN_FINGERPRINT: "11".repeat(32) },
    "/tmp/no-such-home"
  )
  assert.equal(fp, VALID_FP)
})

test("resolveFingerprint falls back to COGNIA_PIN_FINGERPRINT", async () => {
  const fp = await resolveFingerprint([], { COGNIA_PIN_FINGERPRINT: VALID_FP }, "/tmp/no-such-home")
  assert.equal(fp, VALID_FP)
})

test("resolveFingerprint returns null when nothing matches", async () => {
  const fp = await resolveFingerprint([], {}, "/tmp/no-such-home")
  assert.equal(fp, null)
})

test("fingerprintToPinDigest accepts deterministic encoder", () => {
  const digest = fingerprintToPinDigest(VALID_FP, (bytes) => `bytes-${bytes.length}`)
  assert.equal(digest, "bytes-32")
})

test("fingerprintToPinDigest yields stable base64 by default", () => {
  const a = fingerprintToPinDigest(VALID_FP)
  const b = fingerprintToPinDigest(VALID_FP)
  assert.equal(a, b)
  // 32 raw bytes → 44 base64 chars (32 / 3 * 4 rounded up, with padding).
  assert.equal(a.length, 44)
})

test("fingerprintToPinDigest throws on bad hex", () => {
  assert.throws(() => fingerprintToPinDigest("ab"))
})

test("rewritePinSet inserts <pin-set> at the marker", () => {
  const before = "<a>\n        <!-- INJECT_PIN_SET keep -->\n</a>"
  const out = rewritePinSet(before, "ZGlnZXN0")
  assert.equal(out.changed, true)
  assert.match(out.xml, /<pin-set/)
  assert.match(out.xml, /<pin digest="SHA-256">ZGlnZXN0<\/pin>/)
  assert.doesNotMatch(out.xml, /INJECT_PIN_SET/)
})

test("rewritePinSet is a no-op when marker is absent", () => {
  const before = "<a>\n        no marker here\n</a>"
  const out = rewritePinSet(before, "ZGlnZXN0")
  assert.equal(out.changed, false)
  assert.equal(out.xml, before)
})

test("main skips when no fingerprint source resolves", async () => {
  const logs = []
  const result = await main({
    resolveFn: async () => null,
    readFn: async () => "should not be read",
    writeFn: async () => {
      throw new Error("should not write")
    },
    targetPath: "/tmp/nsc.xml",
    logger: { log: (m) => logs.push(m), warn: () => {} },
  })
  assert.deepEqual(result, { kind: "skipped", reason: "no-fingerprint" })
})

test("main injects when fingerprint + marker present", async () => {
  let writtenPath = null
  let writtenContent = null
  const result = await main({
    resolveFn: async () => VALID_FP,
    readFn: async () => "<x>\n        <!-- INJECT_PIN_SET -->\n</x>",
    writeFn: async (p, c) => {
      writtenPath = p
      writtenContent = c
    },
    targetPath: "/tmp/nsc.xml",
    logger: { log: () => {}, warn: () => {} },
  })
  assert.equal(result.kind, "injected")
  assert.equal(writtenPath, "/tmp/nsc.xml")
  assert.match(writtenContent, /<pin-set/)
  assert.match(writtenContent, /<pin digest="SHA-256">/)
})

test("main warns and skips when marker is missing", async () => {
  const warns = []
  const result = await main({
    resolveFn: async () => VALID_FP,
    readFn: async () => "<x>no marker</x>",
    writeFn: async () => {
      throw new Error("should not write")
    },
    targetPath: "/tmp/nsc.xml",
    logger: { log: () => {}, warn: (m) => warns.push(m) },
  })
  assert.deepEqual(result, { kind: "skipped", reason: "marker-missing" })
  assert.ok(warns.length > 0)
})

test("main reports missing-nsc when read fails", async () => {
  const result = await main({
    resolveFn: async () => VALID_FP,
    readFn: async () => {
      throw new Error("ENOENT")
    },
    writeFn: async () => {
      throw new Error("should not write")
    },
    targetPath: "/tmp/nsc.xml",
    logger: { log: () => {}, warn: () => {} },
  })
  assert.deepEqual(result, { kind: "skipped", reason: "missing-nsc" })
})
