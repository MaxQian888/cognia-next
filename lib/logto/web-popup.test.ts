/** @jest-environment jsdom */

import {
  createLogtoWebPopupDrivers,
  LOGTO_CALLBACK_STATE_KEY,
  readValidatedLogtoCallback,
} from "./web-popup"

describe("Logto web popup", () => {
  afterEach(() => window.localStorage.clear())

  it("consumes a matching state exactly once", () => {
    window.localStorage.setItem(LOGTO_CALLBACK_STATE_KEY, "expected")
    expect(readValidatedLogtoCallback("?code=code-a&state=expected")).toEqual({
      __cogniaLogto: true,
      code: "code-a",
      state: "expected",
      error: null,
    })
    expect(readValidatedLogtoCallback("?code=replay&state=expected").error).toBe("state_mismatch")
  })

  it("rejects mismatched state without forwarding the code", () => {
    window.localStorage.setItem(LOGTO_CALLBACK_STATE_KEY, "expected")
    expect(readValidatedLogtoCallback("?code=stolen&state=other")).toMatchObject({
      code: null,
      error: "state_mismatch",
    })
  })

  it("pins messages to the current origin and expected state", async () => {
    const drivers = createLogtoWebPopupDrivers()
    const pending = drivers.waitForCode({ redirectUri: "/logto/callback", state: "expected" })
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: window,
        data: { __cogniaLogto: true, code: "code-a", state: "expected", error: null },
      })
    )
    await expect(pending).resolves.toEqual({ code: "code-a", state: "expected" })
  })
})
