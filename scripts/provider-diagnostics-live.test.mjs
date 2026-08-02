import assert from "node:assert/strict"
import test from "node:test"

import { runLiveProviderDiagnostics } from "./provider-diagnostics-live.mjs"

test("missing credentials remain explicit unverified evidence without network fallbacks", async () => {
  let fetches = 0
  const report = await runLiveProviderDiagnostics({
    env: {},
    fetchImpl: async () => {
      fetches += 1
      throw new Error("must not fetch")
    },
  })
  assert.equal(report.complete, false)
  assert.equal(report.evidence.length, 9)
  assert.ok(report.evidence.every((item) => item.status === "unverified"))
  assert.equal(fetches, 0)
})

test("balance evidence records real HTTP and JSON validation", async () => {
  const report = await runLiveProviderDiagnostics({
    env: {
      BALANCE_ABSOLUTE_URL: "https://balance.example",
      BALANCE_ABSOLUTE_TOKEN: "secret",
    },
    fetchImpl: async () => new Response('{"remaining":5}', { status: 200 }),
  })
  assert.equal(
    report.evidence.find((item) => item.family === "balance-absolute-bearer")?.status,
    "verified"
  )
})

test("structured failures redact configured credential material", async () => {
  const env = {
    BALANCE_ABSOLUTE_URL: "https://balance.example",
    BALANCE_ABSOLUTE_TOKEN: "top-secret-token",
  }
  const report = await runLiveProviderDiagnostics({
    env,
    fetchImpl: async () => {
      throw new Error("request rejected for top-secret-token")
    },
  })
  const evidence = report.evidence.find((item) => item.family === "balance-absolute-bearer")
  assert.equal(evidence.error, "request rejected for [REDACTED]")
  assert.equal(JSON.stringify(report).includes("top-secret-token"), false)
})
