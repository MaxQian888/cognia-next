/** @jest-environment jsdom */

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
  transport: {
    call: jest.fn(async () => null),
  },
}))

jest.mock("./credential-store", () => ({
  loadCodexCredential: jest.fn(async () => null),
  saveCodexCredential: jest.fn(async () => undefined),
  clearCodexCredential: jest.fn(async () => undefined),
  isCodexCredentialFresh: jest.requireActual("./credential-store").isCodexCredentialFresh,
}))

jest.mock("./discovery", () => ({
  discoverCodexAuth: jest.fn(async () => null),
  discoveredToCredential: jest.requireActual("./discovery").discoveredToCredential,
}))

jest.mock("./oauth", () => {
  const actual = jest.requireActual("./oauth")
  return {
    ...actual,
    refreshCodexToken: jest.fn(async () => ({ access_token: "" })),
    revokeCodexToken: jest.fn(async () => undefined),
  }
})

import { act, renderHook, waitFor } from "@testing-library/react"

import { isTauri } from "@/lib/tauri"

import * as credentialStore from "./credential-store"
import * as discoveryMod from "./discovery"
import * as oauthMod from "./oauth"
import { useCodexCredential, useCodexDiscovery } from "./hooks"
import type { CodexCredential, DiscoveredCodexAuth } from "./types"

const mIsTauri = isTauri as jest.Mock
const mLoadCred = credentialStore.loadCodexCredential as jest.Mock
const mSaveCred = credentialStore.saveCodexCredential as jest.Mock
const mClearCred = credentialStore.clearCodexCredential as jest.Mock
const mDiscover = discoveryMod.discoverCodexAuth as jest.Mock
const mRefreshToken = oauthMod.refreshCodexToken as jest.Mock
const mRevokeToken = oauthMod.revokeCodexToken as jest.Mock

const sample: CodexCredential = {
  accessToken: "oat-test",
  refreshToken: "rt-test",
  idTokenRaw: "eyJ.x.y",
  // Comfortably past the 60s grace window so isFresh is true under any clock skew.
  expiresAtMs: Date.now() + 60 * 60 * 1000,
  authMode: "chatgpt",
  email: "user@example.com",
  chatgptPlanType: "plus",
  originalSource: "file",
  storedAtMs: Date.now(),
}

const discovered: DiscoveredCodexAuth = {
  source: "file",
  authJsonPath: "/home/user/.codex/auth.json",
  authMode: "ChatGPT",
  tokens: {
    accessToken: "oat-from-cli",
    refreshToken: "rt-from-cli",
    idTokenRaw: "eyJ.cli.jwt",
    accountId: "acct_x",
    email: "user@example.com",
    chatgptPlanType: "Plus",
    chatgptUserId: "user_x",
    chatgptAccountId: "acct_x",
  },
}

beforeEach(() => {
  mIsTauri.mockReturnValue(true)
  mLoadCred.mockReset()
  mSaveCred.mockReset()
  mClearCred.mockReset()
  mDiscover.mockReset()
  mRefreshToken.mockReset()
  mRevokeToken.mockReset()
  mLoadCred.mockResolvedValue(null)
  mSaveCred.mockResolvedValue(undefined)
  mClearCred.mockResolvedValue(undefined)
  mDiscover.mockResolvedValue(null)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("useCodexCredential", () => {
  it("loads the existing credential on mount", async () => {
    mLoadCred.mockResolvedValueOnce(sample)
    const { result } = renderHook(() => useCodexCredential())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.credential).toEqual(sample)
    expect(result.current.isFresh).toBe(true)
  })

  it("treats web mode (isTauri=false) as logged-out", async () => {
    mIsTauri.mockReturnValue(false)
    const { result } = renderHook(() => useCodexCredential())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mLoadCred).not.toHaveBeenCalled()
    expect(result.current.credential).toBeNull()
    expect(result.current.isFresh).toBe(false)
  })

  it("adoptDiscovered persists the credential and updates state", async () => {
    mLoadCred.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useCodexCredential())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      const adopted = await result.current.adoptDiscovered(discovered)
      expect(adopted?.authMode).toBe("chatgpt")
      expect(adopted?.accessToken).toBe("oat-from-cli")
    })
    expect(mSaveCred).toHaveBeenCalled()
    expect(result.current.credential?.accessToken).toBe("oat-from-cli")
  })

  it("adoptDiscovered returns null when discovery has no usable token", async () => {
    mLoadCred.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useCodexCredential())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const empty: DiscoveredCodexAuth = {
      source: "file",
      authJsonPath: "/p",
    }
    await act(async () => {
      const adopted = await result.current.adoptDiscovered(empty)
      expect(adopted).toBeNull()
    })
    expect(result.current.credential).toBeNull()
  })

  it("refresh rotates the chatgpt bearer", async () => {
    mLoadCred.mockResolvedValueOnce(sample)
    mRefreshToken.mockResolvedValueOnce({
      access_token: "oat-rotated",
      refresh_token: "rt-rotated",
      id_token: "eyJ.rotated.jwt",
      expires_in: 1800,
    })
    const { result } = renderHook(() => useCodexCredential())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      const next = await result.current.refresh()
      expect(next?.accessToken).toBe("oat-rotated")
      expect(next?.refreshToken).toBe("rt-rotated")
    })
    expect(mSaveCred).toHaveBeenCalled()
    expect(result.current.credential?.accessToken).toBe("oat-rotated")
  })

  it("refresh skips api_key credentials without calling the network", async () => {
    // api_key credentials have refreshToken="" → refresh() returns null
    // immediately (the early `!credential.refreshToken` guard fires).
    const apiKeyCred: CodexCredential = {
      accessToken: "sk-x",
      refreshToken: "",
      idTokenRaw: "",
      expiresAtMs: 0,
      authMode: "api_key",
      storedAtMs: Date.now(),
    }
    mLoadCred.mockResolvedValueOnce(apiKeyCred)
    const { result } = renderHook(() => useCodexCredential())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      const next = await result.current.refresh()
      expect(next).toBeNull()
    })
    expect(mRefreshToken).not.toHaveBeenCalled()
  })

  it("signOut clears the credential", async () => {
    mLoadCred.mockResolvedValueOnce(sample)
    const { result } = renderHook(() => useCodexCredential())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.signOut()
    })
    expect(mClearCred).toHaveBeenCalled()
    expect(result.current.credential).toBeNull()
  })

  it("signOut with revoke=true calls revokeCodexToken first", async () => {
    mLoadCred.mockResolvedValueOnce(sample)
    mRevokeToken.mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useCodexCredential())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.signOut({ revoke: true })
    })
    expect(mRevokeToken).toHaveBeenCalledWith("rt-test")
    expect(result.current.credential).toBeNull()
  })

  it("signOut swallows revoke failures so local clear still happens", async () => {
    mLoadCred.mockResolvedValueOnce(sample)
    mRevokeToken.mockRejectedValueOnce(new Error("network down"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const { result } = renderHook(() => useCodexCredential())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.signOut({ revoke: true })
    })
    expect(mClearCred).toHaveBeenCalled()
    expect(result.current.credential).toBeNull()
    warn.mockRestore()
  })

  it("reload re-fetches from the keyring", async () => {
    mLoadCred.mockResolvedValueOnce(null).mockResolvedValueOnce(sample)
    const { result } = renderHook(() => useCodexCredential())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.credential).toBeNull()
    await act(async () => {
      await result.current.reload()
    })
    expect(mLoadCred).toHaveBeenCalledTimes(2)
    expect(result.current.credential).toEqual(sample)
  })
})

describe("useCodexDiscovery", () => {
  it("loads the discovery payload on mount", async () => {
    mDiscover.mockResolvedValueOnce(discovered)
    const { result } = renderHook(() => useCodexDiscovery())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.discovered).toEqual(discovered)
    expect(result.current.error).toBeNull()
  })

  it("surfaces discovery errors", async () => {
    mDiscover.mockRejectedValueOnce(new Error("parse failed"))
    const { result } = renderHook(() => useCodexDiscovery())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.discovered).toBeNull()
    expect(result.current.error).toBe("parse failed")
  })

  it("treats web mode as no codex-cli detected", async () => {
    mIsTauri.mockReturnValue(false)
    const { result } = renderHook(() => useCodexDiscovery())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mDiscover).not.toHaveBeenCalled()
    expect(result.current.discovered).toBeNull()
  })

  it("reload re-probes and updates state", async () => {
    mDiscover.mockResolvedValueOnce(null).mockResolvedValueOnce(discovered)
    const { result } = renderHook(() => useCodexDiscovery())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.discovered).toBeNull()
    await act(async () => {
      await result.current.reload()
    })
    expect(mDiscover).toHaveBeenCalledTimes(2)
    expect(result.current.discovered).toEqual(discovered)
  })
})
