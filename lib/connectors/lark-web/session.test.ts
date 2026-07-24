/** @jest-environment jsdom */

import {
  LARK_WEB_SESSION_STORAGE_KEY,
  buildLarkLoginUrl,
  captureLarkSessionFromLocation,
  clearLarkWebSession,
  decodeJwtPayload,
  getLarkWebSession,
} from "./session"

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
  return `${encode({ alg: "HS256" })}.${encode(payload)}.sig`
}

describe("lark web session", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    window.history.replaceState(null, "", "/lark/entry?entry=x")
  })

  it("captures the fragment token, stores it, and strips the hash", () => {
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    window.location.hash = `#lark_session=${token}`
    expect(captureLarkSessionFromLocation()).toBe(token)
    expect(window.sessionStorage.getItem(LARK_WEB_SESSION_STORAGE_KEY)).toBe(token)
    expect(window.location.hash).toBe("")
    // Idempotent when no fragment remains.
    expect(captureLarkSessionFromLocation()).toBeNull()
  })

  it("drops expired sessions on read", () => {
    const live = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    window.sessionStorage.setItem(LARK_WEB_SESSION_STORAGE_KEY, live)
    expect(getLarkWebSession()).toBe(live)

    const stale = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 10 })
    window.sessionStorage.setItem(LARK_WEB_SESSION_STORAGE_KEY, stale)
    expect(getLarkWebSession()).toBeNull()
    expect(window.sessionStorage.getItem(LARK_WEB_SESSION_STORAGE_KEY)).toBeNull()

    clearLarkWebSession()
    expect(getLarkWebSession()).toBeNull()
  })

  it("decodes payloads defensively", () => {
    expect(decodeJwtPayload("junk")).toBeNull()
    expect(decodeJwtPayload("a.!!!.c")).toBeNull()
    expect(decodeJwtPayload(fakeJwt({ adapter_id: "lk-1" }))).toMatchObject({
      adapter_id: "lk-1",
    })
  })

  it("builds companion login URLs", () => {
    expect(buildLarkLoginUrl("https://api.example", "lk-1", "/lark/entry?entry=x")).toBe(
      "https://api.example/integrations/lark/web/login?adapter_id=lk-1&return_to=%2Flark%2Fentry%3Fentry%3Dx"
    )
  })

  it("survives storage failures and treats exp-less tokens as expired", () => {
    // No fragment at all → null capture.
    expect(captureLarkSessionFromLocation()).toBeNull()

    // Quota/private-mode storage failure: capture still returns the token.
    const token = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    window.location.hash = `#lark_session=${token}`
    const setSpy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    expect(captureLarkSessionFromLocation()).toBe(token)
    setSpy.mockRestore()

    // Stored token without an exp claim reads as expired → dropped.
    window.sessionStorage.setItem(LARK_WEB_SESSION_STORAGE_KEY, fakeJwt({ scope: "lark_web" }))
    expect(getLarkWebSession()).toBeNull()

    // Storage read failure → null, not a crash.
    const getSpy = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(getLarkWebSession()).toBeNull()
    getSpy.mockRestore()
  })
})
