import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCallback } from "../../../mcp-oauth-helper.mjs"
import { startCallbackServer } from "./callback.ts"

test("parseCallback extracts code/state/error", () => {
  assert.deepEqual(parseCallback("/callback?code=abc&state=xy"), {
    code: "abc",
    state: "xy",
    error: undefined,
    errorDescription: undefined,
  })
  const denied = parseCallback("/callback?error=access_denied&error_description=nope")
  assert.equal(denied.error, "access_denied")
  assert.equal(denied.errorDescription, "nope")
})

test("parseCallback yields no code for a query-less url", () => {
  assert.equal(parseCallback("::::").code, undefined)
})

test("loopback callback captures redirects arriving before or after the waiter", async () => {
  for (const early of [true, false]) {
    const callback = await startCallbackServer()
    try {
      const pending = early ? undefined : callback.waitForCode(1000)
      const response = await fetch(`${callback.redirectUrl}?code=accepted&state=csrf`)
      assert.equal(response.status, 200)
      await response.text()
      assert.deepEqual(await (pending ?? callback.waitForCode(1000)), {
        code: "accepted",
        state: "csrf",
        error: undefined,
        errorDescription: undefined,
      })
    } finally {
      callback.close()
    }
  }
})

test("loopback callback retains authorization rejection before a waiter is registered", async () => {
  const callback = await startCallbackServer()
  try {
    const response = await fetch(`${callback.redirectUrl}?error=access_denied`)
    assert.equal(response.status, 400)
    await response.text()
    await assert.rejects(callback.waitForCode(1000), /Authorization denied: access_denied/)
  } finally {
    callback.close()
  }
})
