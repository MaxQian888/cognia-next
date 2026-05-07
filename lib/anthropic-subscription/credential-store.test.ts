// IPC wrappers + the local `isCredentialFresh` helper. After M1.4 these
// route through `transport` from `@/lib/tauri`; the previous Tauri-only
// guard was dropped because the WebStubTransport now produces an
// equivalent error path in plain-web mode and the Capacitor companion
// (M2.7) can transparently proxy these to the desktop's keyring.

import { transport } from "@/lib/tauri"

import {
  clearCredential,
  isCredentialFresh,
  loadCredential,
  saveCredential,
} from "./credential-store"
import type { SubscriptionCredential } from "./types"

const sample: SubscriptionCredential = {
  accessToken: "oat01-test",
  refreshToken: "rt-test",
  expiresAtMs: Date.now() + 60 * 60 * 1000,
  mode: "subscription",
  scope: "user:profile user:inference",
  email: "user@example.com",
  plan: "pro",
  storedAtMs: Date.now(),
}

let callSpy: jest.SpiedFunction<typeof transport.call>

beforeEach(() => {
  callSpy = jest.spyOn(transport, "call")
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("subscription credential transport wrappers", () => {
  it("saveCredential calls claude_sub_save_token with the payload", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await saveCredential(sample)
    expect(callSpy).toHaveBeenCalledWith("claude_sub_save_token", { payload: sample })
  })

  it("loadCredential returns the credential when present", async () => {
    callSpy.mockResolvedValueOnce(sample)
    const got = await loadCredential()
    expect(callSpy).toHaveBeenCalledWith("claude_sub_load_token")
    expect(got).toEqual(sample)
  })

  it("loadCredential normalises a missing entry to null", async () => {
    callSpy.mockResolvedValueOnce(null)
    expect(await loadCredential()).toBeNull()
  })

  it("loadCredential normalises undefined to null too", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    expect(await loadCredential()).toBeNull()
  })

  it("clearCredential calls claude_sub_clear_token", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await clearCredential()
    expect(callSpy).toHaveBeenCalledWith("claude_sub_clear_token")
  })

  it("propagates Rust errors from save", async () => {
    callSpy.mockRejectedValueOnce("access_token must not be empty")
    await expect(saveCredential({ ...sample, accessToken: "" })).rejects.toBe(
      "access_token must not be empty"
    )
  })

  it("plain-web mode rejects through the WebStub transport", async () => {
    callSpy.mockRestore()
    await expect(saveCredential(sample)).rejects.toThrow(
      /tauri-only command from web mode: claude_sub_save_token/
    )
    await expect(loadCredential()).rejects.toThrow(
      /tauri-only command from web mode: claude_sub_load_token/
    )
    await expect(clearCredential()).rejects.toThrow(
      /tauri-only command from web mode: claude_sub_clear_token/
    )
  })
})

describe("isCredentialFresh", () => {
  it("returns false for null", () => {
    expect(isCredentialFresh(null)).toBe(false)
  })

  it("returns false when the access_token is empty", () => {
    expect(isCredentialFresh({ ...sample, accessToken: "" })).toBe(false)
  })

  it("returns true when the credential expires comfortably in the future", () => {
    const now = 1_700_000_000_000
    const c = { ...sample, expiresAtMs: now + 10 * 60 * 1000 }
    expect(isCredentialFresh(c, now)).toBe(true)
  })

  it("returns false within the grace window of expiry", () => {
    const now = 1_700_000_000_000
    // grace defaults to 60s — set expiry 30s away.
    const c = { ...sample, expiresAtMs: now + 30_000 }
    expect(isCredentialFresh(c, now)).toBe(false)
  })

  it("respects a custom grace window", () => {
    const now = 1_700_000_000_000
    const c = { ...sample, expiresAtMs: now + 30_000 }
    // 10s grace — the 30s buffer is still fresh.
    expect(isCredentialFresh(c, now, 10_000)).toBe(true)
  })

  it("returns false once expiry has elapsed", () => {
    const now = 1_700_000_000_000
    const c = { ...sample, expiresAtMs: now - 1 }
    expect(isCredentialFresh(c, now)).toBe(false)
  })
})
