// IPC wrappers + `isCodexCredentialFresh`. Mirrors the Anthropic
// subscription test pattern — spies on `transport.call` so we exercise
// the renderer ⇄ Rust wire shape without touching Tauri.

import { transport } from "@/lib/tauri"

import {
  clearCodexCredential,
  isCodexCredentialFresh,
  loadCodexCredential,
  saveCodexCredential,
} from "./credential-store"
import type { CodexCredential } from "./types"

const sample: CodexCredential = {
  accessToken: "oat-codex-test",
  refreshToken: "rt-codex-test",
  idTokenRaw: "eyJ.fake.jwt",
  expiresAtMs: Date.now() + 60 * 60 * 1000,
  authMode: "chatgpt",
  email: "user@example.com",
  chatgptPlanType: "plus",
  chatgptUserId: "user_abc",
  accountId: "acct_def",
  originalSource: "file",
  storedAtMs: Date.now(),
}

let callSpy: jest.SpiedFunction<typeof transport.call>

beforeEach(() => {
  callSpy = jest.spyOn(transport, "call")
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("codex credential transport wrappers", () => {
  it("saveCodexCredential calls codex_sub_save_token with the payload", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await saveCodexCredential(sample)
    expect(callSpy).toHaveBeenCalledWith("codex_sub_save_token", { payload: sample })
  })

  it("loadCodexCredential returns the credential when present", async () => {
    callSpy.mockResolvedValueOnce(sample)
    const got = await loadCodexCredential()
    expect(callSpy).toHaveBeenCalledWith("codex_sub_load_token")
    expect(got).toEqual(sample)
  })

  it("loadCodexCredential normalises a missing entry to null", async () => {
    callSpy.mockResolvedValueOnce(null)
    expect(await loadCodexCredential()).toBeNull()
  })

  it("loadCodexCredential normalises undefined to null too", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    expect(await loadCodexCredential()).toBeNull()
  })

  it("clearCodexCredential calls codex_sub_clear_token", async () => {
    callSpy.mockResolvedValueOnce(undefined)
    await clearCodexCredential()
    expect(callSpy).toHaveBeenCalledWith("codex_sub_clear_token")
  })

  it("propagates Rust errors from save", async () => {
    callSpy.mockRejectedValueOnce("at least one of access_token / refresh_token must be set")
    await expect(
      saveCodexCredential({ ...sample, accessToken: "", refreshToken: "" })
    ).rejects.toBe("at least one of access_token / refresh_token must be set")
  })

  it("plain-web mode rejects through the WebStub transport", async () => {
    callSpy.mockRestore()
    await expect(saveCodexCredential(sample)).rejects.toThrow(
      /tauri-only command from web mode: codex_sub_save_token/
    )
    await expect(loadCodexCredential()).rejects.toThrow(
      /tauri-only command from web mode: codex_sub_load_token/
    )
    await expect(clearCodexCredential()).rejects.toThrow(
      /tauri-only command from web mode: codex_sub_clear_token/
    )
  })
})

describe("isCodexCredentialFresh", () => {
  it("returns false for null", () => {
    expect(isCodexCredentialFresh(null)).toBe(false)
  })

  it("returns false when access_token is empty", () => {
    expect(isCodexCredentialFresh({ ...sample, accessToken: "" })).toBe(false)
  })

  it("returns true when chatgpt credential has comfortable expiry", () => {
    const now = 1_700_000_000_000
    const c = { ...sample, expiresAtMs: now + 10 * 60 * 1000 }
    expect(isCodexCredentialFresh(c, now)).toBe(true)
  })

  it("returns false within the grace window", () => {
    const now = 1_700_000_000_000
    const c = { ...sample, expiresAtMs: now + 30_000 }
    expect(isCodexCredentialFresh(c, now)).toBe(false)
  })

  it("respects a custom grace window", () => {
    const now = 1_700_000_000_000
    const c = { ...sample, expiresAtMs: now + 30_000 }
    expect(isCodexCredentialFresh(c, now, 10_000)).toBe(true)
  })

  it("treats api_key mode as always fresh when token is present", () => {
    const c: CodexCredential = {
      accessToken: "sk-test-1234",
      refreshToken: "",
      idTokenRaw: "",
      expiresAtMs: 0,
      authMode: "api_key",
      storedAtMs: 0,
    }
    expect(isCodexCredentialFresh(c, 999)).toBe(true)
  })

  it("treats expiresAtMs=0 in chatgpt mode as fresh (refresh-pending state)", () => {
    // After Adopt we leave expiresAtMs=0 until the first refresh.
    const c: CodexCredential = { ...sample, expiresAtMs: 0 }
    expect(isCodexCredentialFresh(c, 999)).toBe(true)
  })
})
