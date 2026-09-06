/** @jest-environment jsdom */

import {
  LOGTO_DEEPLINK_CALLBACK_EVENT,
  publishLogtoDeepLinkCallback,
  waitForLogtoDeepLinkCallback,
} from "./deep-link-callback"

function route(overrides: Partial<Parameters<typeof publishLogtoDeepLinkCallback>[0]> = {}) {
  return {
    kind: "logto_callback" as const,
    code: "code-1",
    state: "state-1",
    error: null,
    raw: "cognia://logto/callback?code=code-1&state=state-1",
    ...overrides,
  }
}

describe("waitForLogtoDeepLinkCallback", () => {
  it("resolves with the code when the published state matches", async () => {
    const pending = waitForLogtoDeepLinkCallback({ state: "state-1" })
    publishLogtoDeepLinkCallback(route())
    await expect(pending).resolves.toEqual({ code: "code-1", state: "state-1" })
  })

  it("rejects a callback minted for another state, with the popup's wording", async () => {
    const pending = waitForLogtoDeepLinkCallback({ state: "state-1" })
    publishLogtoDeepLinkCallback(route({ state: "other" }))
    await expect(pending).rejects.toThrow("Logto callback state mismatch")
  })

  it("rejects an authorization error and a callback without a code", async () => {
    const denied = waitForLogtoDeepLinkCallback({ state: "s" })
    publishLogtoDeepLinkCallback(route({ state: "s", error: "access_denied" }))
    await expect(denied).rejects.toThrow("Logto authorization failed: access_denied")

    const empty = waitForLogtoDeepLinkCallback({ state: "s" })
    publishLogtoDeepLinkCallback(route({ state: "s", code: null }))
    await expect(empty).rejects.toThrow("Logto callback is missing code")
  })

  it("stops listening once settled and when aborted", async () => {
    const controller = new AbortController()
    const pending = waitForLogtoDeepLinkCallback({ state: "s", signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })

    const spy = jest.spyOn(window, "removeEventListener")
    const settled = waitForLogtoDeepLinkCallback({ state: "s" })
    publishLogtoDeepLinkCallback(route({ state: "s" }))
    await settled
    expect(spy).toHaveBeenCalledWith(LOGTO_DEEPLINK_CALLBACK_EVENT, expect.any(Function))
    spy.mockRestore()
  })

  it("ignores foreign events on the same channel", async () => {
    const pending = waitForLogtoDeepLinkCallback({ state: "s" })
    window.dispatchEvent(new CustomEvent(LOGTO_DEEPLINK_CALLBACK_EVENT, { detail: null }))
    publishLogtoDeepLinkCallback(route({ state: "s" }))
    await expect(pending).resolves.toEqual({ code: "code-1", state: "s" })
  })

  it("publishing with nobody waiting is a no-op", () => {
    expect(() => publishLogtoDeepLinkCallback(route())).not.toThrow()
  })
})
