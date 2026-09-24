import { __resetSubscriptionBreakerForTesting } from "@/lib/subscription/retry/breaker"

import { CodexReauthenticationRequiredError, refreshCodexAccountIfStale } from "./refresh"
import { discoverCodexAuth, discoveredToCredential } from "./discovery"
import { reauthenticateManagedCodexAccount } from "@/lib/subscription/core/transport"

import type { Account, CodexCredentialData } from "@/types/subscription"

// The token-endpoint block is process-wide by design, so a case that makes a
// refresh fail would otherwise gate every later case for the same account id.
beforeEach(() => {
  __resetSubscriptionBreakerForTesting()
  jest.mocked(reauthenticateManagedCodexAccount).mockReset()
})

jest.mock("./discovery", () => ({
  discoverCodexAuth: jest.fn(),
  discoveredToCredential: jest.fn(),
}))

// Never load the native transport or a real account store in this unit suite.
jest.mock("@/lib/subscription/core/transport", () => ({
  getAccount: jest.fn(),
  saveAccount: jest.fn(),
  setActiveAccount: jest.fn(),
  refreshManagedCodexAccount: jest.fn(),
  reauthenticateManagedCodexAccount: jest.fn(),
}))

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
    discoverLocalCredential: jest.fn().mockResolvedValue(null),
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

  it("re-syncs a reused CLI login without rotating the CLI refresh token copy", async () => {
    const linked = credential({ originalSource: "file" })
    const local = credential({
      accessToken: "cli-current-bearer",
      refreshToken: "cli-current-refresh",
      expiresAtMs: NOW + 3_600_000,
      originalSource: "file",
    })
    const d = deps({
      getAccount: jest.fn().mockResolvedValue(account(linked)),
      discoverLocalCredential: jest.fn().mockResolvedValue(local),
    })

    const fresh = await refreshCodexAccountIfStale("acc-1", d)

    expect(fresh?.accessToken).toBe("cli-current-bearer")
    expect(d.discoverLocalCredential).toHaveBeenCalledTimes(1)
    expect(d.refreshCodexToken).not.toHaveBeenCalled()
    expect(reauthenticateManagedCodexAccount).toHaveBeenCalledWith("acc-1", local)
    expect(d.saveAccount).not.toHaveBeenCalled()
  })

  it("rejects a different CLI identity without saving, activating, or refreshing it", async () => {
    jest
      .mocked(reauthenticateManagedCodexAccount)
      .mockRejectedValue(
        new Error("Codex reauthentication identity mismatch; original account was not changed")
      )
    const d = deps({
      getAccount: jest.fn().mockResolvedValue(account(credential({ originalSource: "file" }))),
      discoverLocalCredential: jest.fn().mockResolvedValue(credential({ originalSource: "file" })),
      reactivate: true,
    })

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(refreshCodexAccountIfStale("acc-1", d)).rejects.toMatchObject({
        code: "reauth_required",
        reason: "external_login_unverified",
      })
    }
    expect(d.saveAccount).not.toHaveBeenCalled()
    expect(d.setActiveAccount).not.toHaveBeenCalled()
    expect(d.refreshCodexToken).not.toHaveBeenCalled()

    // Restoring the original CLI login must recover without a latched refresh breaker.
    jest.mocked(reauthenticateManagedCodexAccount).mockResolvedValue(undefined as never)
    await expect(refreshCodexAccountIfStale("acc-1", d)).resolves.toMatchObject({
      originalSource: "file",
    })
  })

  it.each([
    { authMode: "api_key" as const, accessToken: "different-api-key" },
    { authMode: "chatgpt" as const, accessToken: "chatgpt-token" },
  ])("does not silently replace a reused API key with $authMode credentials", async (next) => {
    const d = deps({
      getAccount: jest
        .fn()
        .mockResolvedValue(account(credential({ originalSource: "file", authMode: "api_key" }))),
      discoverLocalCredential: jest
        .fn()
        .mockResolvedValue(credential({ originalSource: "file", ...next })),
    })
    await expect(refreshCodexAccountIfStale("acc-1", d)).rejects.toMatchObject({
      code: "reauth_required",
    })
    expect(d.saveAccount).not.toHaveBeenCalled()
    expect(d.refreshCodexToken).not.toHaveBeenCalled()
    expect(reauthenticateManagedCodexAccount).not.toHaveBeenCalled()
  })

  it("keeps an unchanged reused API key without rewriting credentials", async () => {
    const linked = credential({ originalSource: "keyring", authMode: "api_key" })
    const d = deps({
      getAccount: jest.fn().mockResolvedValue(account(linked)),
      discoverLocalCredential: jest.fn().mockResolvedValue(linked),
    })
    await expect(refreshCodexAccountIfStale("acc-1", d)).resolves.toEqual(linked)
    expect(d.saveAccount).not.toHaveBeenCalled()
    expect(d.refreshCodexToken).not.toHaveBeenCalled()
    expect(reauthenticateManagedCodexAccount).not.toHaveBeenCalled()
  })

  it("uses the default CLI discovery adapter for a linked account", async () => {
    const linked = credential({ originalSource: "file" })
    const local = credential({ accessToken: "discovered-bearer", originalSource: "file" })
    jest.mocked(discoverCodexAuth).mockResolvedValue({ source: "file", credential: {} } as never)
    jest.mocked(discoveredToCredential).mockReturnValue(local)
    const { discoverLocalCredential: _discoverLocalCredential, ...d } = deps({
      getAccount: jest.fn().mockResolvedValue(account(linked)),
    })

    const fresh = await refreshCodexAccountIfStale("acc-1", d)

    expect(fresh).toBe(local)
    expect(discoverCodexAuth).toHaveBeenCalledTimes(1)
    expect(discoveredToCredential).toHaveBeenCalledTimes(1)
  })

  it("uses the wall clock when no custom clock is supplied", async () => {
    const { now: _now, ...d } = deps()

    await refreshCodexAccountIfStale("acc-1", d)

    expect(d.saveAccount.mock.calls[0][1].lastUsedAtMs).toBeGreaterThan(0)
  })

  it("re-activates a keyring-linked account after syncing the CLI login", async () => {
    const linked = credential({ originalSource: "keyring" })
    const d = deps({
      getAccount: jest.fn().mockResolvedValue(account(linked)),
      discoverLocalCredential: jest
        .fn()
        .mockResolvedValue(credential({ originalSource: "keyring" })),
      reactivate: true,
    })

    await refreshCodexAccountIfStale("acc-1", d)

    expect(d.refreshCodexToken).not.toHaveBeenCalled()
    expect(d.setActiveAccount).toHaveBeenCalledWith("codex", "acc-1")
  })

  it("keeps a linked account unchanged when the CLI login is unavailable", async () => {
    const d = deps({
      getAccount: jest.fn().mockResolvedValue(account(credential({ originalSource: "file" }))),
      discoverLocalCredential: jest.fn().mockResolvedValue(null),
    })

    await expect(refreshCodexAccountIfStale("acc-1", d)).rejects.toMatchObject({
      code: "reauth_required",
      reason: "external_login_unavailable",
    })
    expect(d.refreshCodexToken).not.toHaveBeenCalled()
    expect(d.saveAccount).not.toHaveBeenCalled()
  })

  it("fails closed when the CLI credential source cannot be read", async () => {
    const d = deps({
      getAccount: jest.fn().mockResolvedValue(account(credential({ originalSource: "keyring" }))),
      discoverLocalCredential: jest.fn().mockRejectedValue(new Error("keyring unavailable")),
      reactivate: true,
    })

    await expect(refreshCodexAccountIfStale("acc-1", d)).rejects.toMatchObject({
      code: "reauth_required",
      reason: "external_login_unavailable",
    })
    expect(d.saveAccount).not.toHaveBeenCalled()
    expect(d.setActiveAccount).not.toHaveBeenCalled()
    expect(d.refreshCodexToken).not.toHaveBeenCalled()
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

  it("never falls back to a renderer token exchange without a host lifecycle", async () => {
    const { refreshCodexToken: _refreshCodexToken, ...d } = deps()

    await expect(refreshCodexAccountIfStale("acc-1", d)).rejects.toThrow(
      "Direct renderer token refresh is disabled"
    )
    expect(d.saveAccount).not.toHaveBeenCalled()
  })

  it("fails before refresh when the vault already requires reauthentication", async () => {
    const blocked = {
      ...account(),
      authMetadata: {
        reauthRequiredAtMs: 123,
        reauthReason: "refresh_token_reused",
      },
    }
    const d = deps({ getAccount: jest.fn().mockResolvedValue(blocked) })

    await expect(refreshCodexAccountIfStale("acc-1", d)).rejects.toBeInstanceOf(
      CodexReauthenticationRequiredError
    )
    expect(d.refreshCodexToken).not.toHaveBeenCalled()
  })

  it("normalizes a host terminal-refresh response into an actionable lifecycle error", async () => {
    const d = deps({
      refreshManagedAccount: jest
        .fn()
        .mockRejectedValue(new Error("reauth_required:invalid_grant")),
    })

    await expect(refreshCodexAccountIfStale("acc-1", d)).rejects.toMatchObject({
      code: "reauth_required",
      reason: "invalid_grant",
    })
    expect(d.saveAccount).not.toHaveBeenCalled()
  })

  it("single-flights concurrent host-managed refreshes", async () => {
    let resolveRefresh!: (value: CodexCredentialData) => void
    const refreshManagedAccount = jest.fn(
      () =>
        new Promise<CodexCredentialData>((resolve) => {
          resolveRefresh = resolve
        })
    )
    const d = deps({ refreshManagedAccount })

    const first = refreshCodexAccountIfStale("acc-1", d)
    const second = refreshCodexAccountIfStale("acc-1", d)
    await Promise.resolve()
    expect(refreshManagedAccount).toHaveBeenCalledTimes(1)

    const fresh = credential({ accessToken: "fresh", expiresAtMs: NOW + 3_600_000 })
    resolveRefresh(fresh)
    await expect(Promise.all([first, second])).resolves.toEqual([fresh, fresh])
  })
})

describe("the token-endpoint block", () => {
  it("does not exchange the same dead token again after a failure", async () => {
    // Both callers here run on hot paths: every external-agent spawn and every
    // chat turn. Without a block, a revoked grant was re-exchanged on each one.
    const d = deps({
      refreshCodexToken: jest.fn().mockRejectedValue(new Error("500: token service down")),
      random: () => 0,
    })
    await expect(refreshCodexAccountIfStale("acc-1", d)).rejects.toThrow()
    expect(d.refreshCodexToken).toHaveBeenCalledTimes(1)

    await expect(refreshCodexAccountIfStale("acc-1", d)).resolves.toBeNull()
    expect(d.refreshCodexToken).toHaveBeenCalledTimes(1)
  })

  it("latches a revoked grant until the user re-authenticates", async () => {
    const d = deps({
      refreshCodexToken: jest.fn().mockRejectedValue(new Error('400: {"error":"invalid_grant"}')),
      random: () => 0,
    })
    await expect(refreshCodexAccountIfStale("acc-1", d)).rejects.toThrow()

    const muchLater = { ...d, now: () => NOW + 30 * 24 * 60 * 60_000 }
    await expect(refreshCodexAccountIfStale("acc-1", muchLater)).resolves.toBeNull()
    expect(d.refreshCodexToken).toHaveBeenCalledTimes(1)
  })

  it("does not block a still-fresh credential that never touched the endpoint", async () => {
    const d = deps({
      refreshCodexToken: jest.fn().mockRejectedValue(new Error("500: token service down")),
      random: () => 0,
    })
    await expect(refreshCodexAccountIfStale("acc-1", d)).rejects.toThrow()

    // A different account is untouched by the first one's block.
    const sibling = deps({
      getAccount: jest.fn().mockResolvedValue({ ...account(), id: "acc-2" }),
      random: () => 0,
    })
    await expect(refreshCodexAccountIfStale("acc-2", sibling)).resolves.toMatchObject({
      accessToken: "fresh-bearer",
    })
  })

  it("clears the block after a successful exchange", async () => {
    const refreshCodexToken = jest
      .fn()
      .mockRejectedValueOnce(new Error("500: token service down"))
      .mockResolvedValue({ access_token: "fresh-bearer", refresh_token: "r2", expires_in: 3600 })
    let clock = NOW
    const d = deps({ refreshCodexToken, now: () => clock, random: () => 0 })

    await expect(refreshCodexAccountIfStale("acc-1", d)).rejects.toThrow()
    clock += 60 * 60_000
    await expect(refreshCodexAccountIfStale("acc-1", d)).resolves.toMatchObject({
      accessToken: "fresh-bearer",
    })
    await expect(refreshCodexAccountIfStale("acc-1", d)).resolves.toMatchObject({
      accessToken: "fresh-bearer",
    })
    expect(refreshCodexToken).toHaveBeenCalledTimes(3)
  })
})
