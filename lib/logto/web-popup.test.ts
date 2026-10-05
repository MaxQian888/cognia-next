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

  describe("the popup window", () => {
    const AUTHORIZE = "https://id.test/authorize?state=s1"
    let open: jest.SpyInstance

    function fakeWindow(closed = false): Window & { replaced: string[] } {
      const replaced: string[] = []
      const win = {
        closed,
        replaced,
        location: { replace: (url: string) => replaced.push(url) },
        close: jest.fn(() => {
          win.closed = true
        }),
      }
      return win as unknown as Window & { replaced: string[] }
    }

    beforeEach(() => {
      open = jest.spyOn(window, "open")
    })
    afterEach(() => open.mockRestore())

    it("is opened only at openUrl time without a reservation", () => {
      const popup = fakeWindow()
      open.mockReturnValue(popup)
      const drivers = createLogtoWebPopupDrivers()
      expect(open).not.toHaveBeenCalled()
      drivers.openUrl(AUTHORIZE)
      expect(open).toHaveBeenCalledWith(AUTHORIZE, "cognia-logto", "popup,width=520,height=720")
      expect(window.localStorage.getItem(LOGTO_CALLBACK_STATE_KEY)).toBe("s1")
    })

    it("is reserved blank at creation and then pointed at the authorize URL", () => {
      const popup = fakeWindow()
      open.mockReturnValue(popup)
      const drivers = createLogtoWebPopupDrivers(undefined, { reserveWindow: true })
      expect(open).toHaveBeenCalledTimes(1)
      expect(open).toHaveBeenCalledWith("about:blank", "cognia-logto", "popup,width=520,height=720")
      drivers.openUrl(AUTHORIZE)
      expect(open).toHaveBeenCalledTimes(1)
      expect(popup.replaced).toEqual([AUTHORIZE])
      // The sign-in window is now the person's; abandoning no longer closes it.
      drivers.abandon?.()
      expect(popup.close).not.toHaveBeenCalled()
    })

    it("opens afresh when the reservation was refused or closed", () => {
      open.mockReturnValueOnce(null)
      const refused = createLogtoWebPopupDrivers(undefined, { reserveWindow: true })
      const second = fakeWindow()
      open.mockReturnValueOnce(second)
      refused.openUrl(AUTHORIZE)
      expect(open).toHaveBeenLastCalledWith(AUTHORIZE, "cognia-logto", "popup,width=520,height=720")

      const closed = fakeWindow(true)
      open.mockReturnValueOnce(closed)
      const drivers = createLogtoWebPopupDrivers(undefined, { reserveWindow: true })
      open.mockReturnValueOnce(fakeWindow())
      drivers.openUrl(AUTHORIZE)
      expect(closed.replaced).toEqual([])
      expect(open).toHaveBeenLastCalledWith(AUTHORIZE, "cognia-logto", "popup,width=520,height=720")
    })

    it("reports a blocked popup and forgets the state it stored", () => {
      open.mockReturnValue(null)
      const drivers = createLogtoWebPopupDrivers(undefined, { reserveWindow: true })
      expect(() => drivers.openUrl(AUTHORIZE)).toThrow("Logto popup was blocked")
      expect(window.localStorage.getItem(LOGTO_CALLBACK_STATE_KEY)).toBeNull()
    })

    it("closes the reserved window when the sign-in is abandoned first", () => {
      const popup = fakeWindow()
      open.mockReturnValue(popup)
      const drivers = createLogtoWebPopupDrivers(undefined, { reserveWindow: true })
      drivers.abandon?.()
      drivers.abandon?.()
      expect(popup.close).toHaveBeenCalledTimes(1)
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
