// IPC wrappers + the local `isCredentialFresh` helper. Same mock harness as
// `lib/ccswitch/client.test.ts` so the behaviour is identical from the
// renderer's perspective.

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/tauri"

import {
  clearCredential,
  isCredentialFresh,
  loadCredential,
  saveCredential,
} from "./credential-store"
import type { SubscriptionCredential } from "./types"

const mInvoke = invoke as jest.Mock
const mIsTauri = isTauri as jest.Mock

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

beforeEach(() => {
  jest.resetAllMocks()
  mIsTauri.mockReturnValue(true)
})

describe("subscription credential IPC wrappers", () => {
  it("saveCredential invokes claude_sub_save_token with the payload", async () => {
    mInvoke.mockResolvedValue(undefined)
    await saveCredential(sample)
    expect(mInvoke).toHaveBeenCalledWith("claude_sub_save_token", { payload: sample })
  })

  it("loadCredential returns the credential when present", async () => {
    mInvoke.mockResolvedValue(sample)
    const got = await loadCredential()
    expect(mInvoke).toHaveBeenCalledWith("claude_sub_load_token")
    expect(got).toEqual(sample)
  })

  it("loadCredential normalises a missing entry to null", async () => {
    mInvoke.mockResolvedValue(null)
    expect(await loadCredential()).toBeNull()
  })

  it("loadCredential normalises undefined to null too", async () => {
    mInvoke.mockResolvedValue(undefined)
    expect(await loadCredential()).toBeNull()
  })

  it("clearCredential invokes claude_sub_clear_token", async () => {
    mInvoke.mockResolvedValue(undefined)
    await clearCredential()
    expect(mInvoke).toHaveBeenCalledWith("claude_sub_clear_token")
  })

  it("propagates Rust errors from save", async () => {
    mInvoke.mockRejectedValue("access_token must not be empty")
    await expect(saveCredential({ ...sample, accessToken: "" })).rejects.toBe(
      "access_token must not be empty"
    )
  })

  it("each command throws when not running inside Tauri", async () => {
    mIsTauri.mockReturnValue(false)
    await expect(saveCredential(sample)).rejects.toThrow(/only available inside Tauri/)
    await expect(loadCredential()).rejects.toThrow(/only available inside Tauri/)
    await expect(clearCredential()).rejects.toThrow(/only available inside Tauri/)
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
