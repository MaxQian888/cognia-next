import { refreshCodexAccountIfStale } from "./refresh"

import type { Account, CodexCredentialData } from "@/types/subscription"

const NOW = 1_000_000

function credential(over: Partial<CodexCredentialData> = {}): CodexCredentialData {
  return {
    accessToken: "stale-bearer",
    refreshToken: "refresh-1",
    idTokenRaw: "",
    // Comfortably expired relative to NOW.
    expiresAtMs: NOW - 1,
    authMode: "chatgpt",
    storedAtMs: 0,
    ...over,
  }
}

function account(cred: CodexCredentialData = credential()): Account {
  return {
    id: "acc-1",
    credential: { provider: "codex", ...cred },
    createdAtMs: 1,
    lastUsedAtMs: 1,
  } as Account
}

function deps(over: Record<string, unknown> = {}) {
  return {
    getAccount: jest.fn().mockResolvedValue(account()),
    saveAccount: jest.fn().mockResolvedValue(undefined),
    setActiveAccount: jest.fn().mockResolvedValue(undefined),
    refreshCodexToken: jest.fn().mockResolvedValue({
      access_token: "fresh-bearer",
      refresh_token: "refresh-2",
      expires_in: 3600,
    }),
    now: () => NOW,
    reactivate: false,
    ...over,
  }
}

describe("refreshCodexAccountIfStale", () => {
  it("refreshes a stale chatgpt bearer and persists the rotated token", async () => {
    const d = deps()
    const fresh = await refreshCodexAccountIfStale("acc-1", d)

    expect(d.refreshCodexToken).toHaveBeenCalledWith("refresh-1")
    expect(fresh?.accessToken).toBe("fresh-bearer")
    // The server rotated the refresh token — the NEW one must be persisted, or
    // the next refresh replays a dead token.
    expect(fresh?.refreshToken).toBe("refresh-2")
    expect(fresh?.expiresAtMs).toBe(NOW + 3600 * 1000)
    const saved = d.saveAccount.mock.calls[0][1]
    expect(saved.credential).toMatchObject({ provider: "codex", accessToken: "fresh-bearer" })
  })

  it("does not flip the active pointer by default (chat must not restart the sidecar)", async () => {
    const d = deps()
    await refreshCodexAccountIfStale("acc-1", d)
    expect(d.setActiveAccount).not.toHaveBeenCalled()
  })

  it("re-activates when asked, so the spawn path's env cache picks up the bearer", async () => {
    const d = deps({ reactivate: true })
    await refreshCodexAccountIfStale("acc-1", d)
    expect(d.setActiveAccount).toHaveBeenCalledWith("codex", "acc-1")
  })

  it("leaves a still-fresh credential alone", async () => {
    const d = deps({
      getAccount: jest.fn().mockResolvedValue(account(credential({ expiresAtMs: NOW + 3600_000 }))),
    })
    expect(await refreshCodexAccountIfStale("acc-1", d)).toBeNull()
    expect(d.refreshCodexToken).not.toHaveBeenCalled()
    expect(d.saveAccount).not.toHaveBeenCalled()
  })

  it("never refreshes an api_key login (keys don't expire)", async () => {
    const d = deps({
      getAccount: jest
        .fn()
        .mockResolvedValue(account(credential({ authMode: "api_key", refreshToken: "" }))),
    })
    expect(await refreshCodexAccountIfStale("acc-1", d)).toBeNull()
    expect(d.refreshCodexToken).not.toHaveBeenCalled()
  })

  it("cannot refresh a chatgpt credential with no refresh token", async () => {
    const d = deps({
      getAccount: jest.fn().mockResolvedValue(account(credential({ refreshToken: "" }))),
    })
    expect(await refreshCodexAccountIfStale("acc-1", d)).toBeNull()
    expect(d.refreshCodexToken).not.toHaveBeenCalled()
  })

  it("treats an unknown expiry (expiresAtMs 0, adopted from the CLI) as fresh", async () => {
    const d = deps({
      getAccount: jest.fn().mockResolvedValue(account(credential({ expiresAtMs: 0 }))),
    })
    expect(await refreshCodexAccountIfStale("acc-1", d)).toBeNull()
    expect(d.refreshCodexToken).not.toHaveBeenCalled()
  })

  it("returns null for a missing or non-codex account", async () => {
    expect(
      await refreshCodexAccountIfStale(
        "acc-1",
        deps({ getAccount: jest.fn().mockResolvedValue(null) })
      )
    ).toBeNull()
    const wrongProvider = {
      ...account(),
      credential: { provider: "anthropic", accessToken: "x" },
    }
    expect(
      await refreshCodexAccountIfStale(
        "acc-1",
        deps({ getAccount: jest.fn().mockResolvedValue(wrongProvider) })
      )
    ).toBeNull()
  })

  it("propagates a failed refresh exchange so callers decide how to degrade", async () => {
    const d = deps({ refreshCodexToken: jest.fn().mockRejectedValue(new Error("invalid_grant")) })
    await expect(refreshCodexAccountIfStale("acc-1", d)).rejects.toThrow("invalid_grant")
    expect(d.saveAccount).not.toHaveBeenCalled()
  })
})
