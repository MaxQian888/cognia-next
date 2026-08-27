import test from "node:test"
import assert from "node:assert/strict"

import { STATUS } from "./diagnose.mjs"
import { FixtureUnavailableError } from "./fixture-client.mjs"
import { checkFixture, doctorPlatform, formatChecks } from "./doctor.mjs"

test("a reachable fixture reports its url and how much it has captured", async () => {
  const check = await checkFixture({
    baseUrl: "http://127.0.0.1:9999",
    probe: async () => ({ ok: true, count: 3 }),
  })
  assert.equal(check.ok, true)
  assert.match(check.detail, /127\.0\.0\.1:9999/)
  assert.match(check.detail, /3 request/)
})

test("an unreachable fixture keeps its actionable message", async () => {
  const check = await checkFixture({
    baseUrl: "http://127.0.0.1:1",
    probe: async () => {
      throw new FixtureUnavailableError("… Is `pnpm im:test:target` still running?")
    },
  })
  assert.equal(check.ok, false)
  assert.match(check.detail, /pnpm im:test:target/)
})

test("an unexpected fixture error is still reported, not thrown", async () => {
  const check = await checkFixture({
    baseUrl: "http://127.0.0.1:1",
    probe: async () => {
      throw new TypeError("boom")
    },
  })
  assert.equal(check.ok, false)
  assert.match(check.detail, /boom/)
})

test("a platform passes only when every one of its checks passes", async () => {
  const pass = await doctorPlatform({
    platform: "telegram",
    driver: { doctor: async () => [{ name: "a", ok: true, detail: "" }] },
  })
  assert.equal(pass.status, STATUS.PASS)

  const fail = await doctorPlatform({
    platform: "telegram",
    driver: {
      doctor: async () => [
        { name: "a", ok: true, detail: "" },
        { name: "b", ok: false, detail: "nope" },
      ],
    },
  })
  assert.equal(fail.status, STATUS.DOCTOR_FAILED)
  assert.equal(fail.checks.length, 2)
})

test("a driver that throws becomes a failed check, not a crashed run", async () => {
  const result = await doctorPlatform({
    platform: "lark",
    driver: {
      doctor: async () => {
        throw new Error("lark tenant token failed: invalid app_secret (10003)")
      },
    },
  })
  assert.equal(result.status, STATUS.DOCTOR_FAILED)
  assert.equal(result.checks[0].name, "driver reachable")
  assert.match(result.checks[0].detail, /invalid app_secret/)
})

test("formatChecks marks failures so they are findable in a scrollback", () => {
  const text = formatChecks("slack", [
    { name: "driver identity", ok: true, detail: "qa.driver" },
    { name: "driver token is a USER token", ok: false, detail: "it is a bot token" },
  ])
  assert.match(text, /^ {2}slack:/m)
  assert.match(text, /ok {3}driver identity — qa\.driver/)
  assert.match(text, /FAIL driver token is a USER token — it is a bot token/)
})

test("a check with no detail still renders cleanly", () => {
  assert.equal(formatChecks("matrix", [{ name: "x", ok: true }]), "  matrix:\n    ok   x")
})
