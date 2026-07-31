/** @jest-environment jsdom */

import { clearLarkOAuthPending, getLarkOAuthPending, setLarkOAuthPending } from "./oauth-pending"

const KEY = "lark-oauth-pending:lk-1"

beforeEach(() => {
  localStorage.clear()
})

describe("setLarkOAuthPending / getLarkOAuthPending", () => {
  it("round-trips state, codeVerifier and redirectUri and stamps ts", () => {
    setLarkOAuthPending("lk-1", {
      state: "lark:lk-1:nonce",
      codeVerifier: "verifier-123",
      redirectUri: "https://tunnel.example/oauth/lark/callback",
    })
    const got = getLarkOAuthPending("lk-1")
    expect(got).not.toBeNull()
    expect(got!.state).toBe("lark:lk-1:nonce")
    expect(got!.codeVerifier).toBe("verifier-123")
    expect(got!.redirectUri).toBe("https://tunnel.example/oauth/lark/callback")
    expect(typeof got!.ts).toBe("number")
  })

  it("returns null when nothing is stored", () => {
    expect(getLarkOAuthPending("lk-1")).toBeNull()
  })

  it("returns null and evicts an expired record", () => {
    // Hand-write a record older than the 10-minute TTL.
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: "s",
        codeVerifier: "v",
        redirectUri: "r",
        ts: Date.now() - 11 * 60 * 1000,
      })
    )
    expect(getLarkOAuthPending("lk-1")).toBeNull()
    // Expired record is evicted on read.
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it("returns null for malformed JSON", () => {
    localStorage.setItem(KEY, "{not json")
    expect(getLarkOAuthPending("lk-1")).toBeNull()
  })

  it("returns null when required fields are missing", () => {
    localStorage.setItem(KEY, JSON.stringify({ state: "s", ts: Date.now() }))
    expect(getLarkOAuthPending("lk-1")).toBeNull()
  })
})

describe("clearLarkOAuthPending", () => {
  it("removes a stored record", () => {
    setLarkOAuthPending("lk-1", { state: "s", codeVerifier: "v", redirectUri: "r" })
    expect(getLarkOAuthPending("lk-1")).not.toBeNull()
    clearLarkOAuthPending("lk-1")
    expect(getLarkOAuthPending("lk-1")).toBeNull()
  })

  it("is a no-op when nothing is stored", () => {
    expect(() => clearLarkOAuthPending("lk-1")).not.toThrow()
  })
})

describe("resilience", () => {
  it("tolerates a storage write failure without throwing", () => {
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded")
    })
    expect(() =>
      setLarkOAuthPending("lk-1", { state: "s", codeVerifier: "v", redirectUri: "r" })
    ).not.toThrow()
    spy.mockRestore()
  })

  it("tolerates a storage remove failure without throwing", () => {
    const spy = jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("boom")
    })
    expect(() => clearLarkOAuthPending("lk-1")).not.toThrow()
    spy.mockRestore()
  })

  it("no-ops when localStorage is unavailable", () => {
    const desc = Object.getOwnPropertyDescriptor(window, "localStorage")
    Object.defineProperty(window, "localStorage", { configurable: true, value: undefined })
    try {
      expect(getLarkOAuthPending("lk-1")).toBeNull()
      expect(() =>
        setLarkOAuthPending("lk-1", { state: "s", codeVerifier: "v", redirectUri: "r" })
      ).not.toThrow()
      expect(() => clearLarkOAuthPending("lk-1")).not.toThrow()
    } finally {
      if (desc) Object.defineProperty(window, "localStorage", desc)
    }
  })
})
