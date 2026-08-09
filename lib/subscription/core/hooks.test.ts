/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"

import type { AccountSummary, ProviderPreset } from "@/types/subscription"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const transport = {
  listAccounts: jest.fn<Promise<AccountSummary[]>, [unknown]>(),
  getActiveAccount: jest.fn<Promise<{ activeAccountId?: string; env: [] }>, [unknown]>(),
  setActiveAccount: jest.fn<Promise<void>, [unknown, string | null]>(),
  renameAccount: jest.fn<Promise<void>, [unknown, string, string | null]>(),
  deleteAccount: jest.fn<Promise<void>, [unknown, string, (string | null)?]>(),
  listPresets: jest.fn<Promise<ProviderPreset[]>, [unknown]>(),
  getProviderPreset: jest.fn<Promise<ProviderPreset | null>, [unknown]>(),
  saveProviderPreset: jest.fn<Promise<void>, [unknown, unknown]>(),
  deleteProviderPreset: jest.fn<Promise<void>, [unknown, unknown]>(),
  setDefaultPreset: jest.fn<Promise<void>, [unknown, unknown]>(),
}

jest.mock("./transport", () => ({
  // Account fns referenced by the module but unused in this suite.
  deleteAccount: (...args: [unknown, string, (string | null)?]) => transport.deleteAccount(...args),
  getAccount: jest.fn(),
  getActiveAccount: (...args: [unknown]) => transport.getActiveAccount(...args),
  listAccounts: (...args: [unknown]) => transport.listAccounts(...args),
  renameAccount: (...args: [unknown, string, string | null]) => transport.renameAccount(...args),
  setActiveAccount: (...args: [unknown, string | null]) => transport.setActiveAccount(...args),
  setProviderPreset: jest.fn(),
  listPresets: (...args: [unknown]) => transport.listPresets(...args),
  getProviderPreset: (...args: [unknown]) => transport.getProviderPreset(...args),
  saveProviderPreset: (...args: [unknown, unknown]) => transport.saveProviderPreset(...args),
  deleteProviderPreset: (...args: [unknown, unknown]) => transport.deleteProviderPreset(...args),
  setDefaultPreset: (...args: [unknown, unknown]) => transport.setDefaultPreset(...args),
}))

jest.mock("./account-lifecycle", () => ({
  deleteProviderAccount: ({ provider, accountId, replacementAccountId }: Record<string, unknown>) =>
    transport.deleteAccount(provider, accountId as string, replacementAccountId as string | null),
}))

import { useAccounts, useProviderPresets } from "./hooks"
import { notifySubscriptionChanged } from "./subscription-events"

const PRESET_A: ProviderPreset = { id: "a", label: "Bedrock", baseUrl: "https://a.example" }
const PRESET_B: ProviderPreset = { id: "b", label: "Azure", baseUrl: "https://b.example" }

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  transport.listPresets.mockResolvedValue([PRESET_A, PRESET_B])
  transport.getProviderPreset.mockResolvedValue(PRESET_A)
  transport.saveProviderPreset.mockResolvedValue(undefined)
  transport.deleteProviderPreset.mockResolvedValue(undefined)
  transport.setDefaultPreset.mockResolvedValue(undefined)
  transport.listAccounts.mockResolvedValue([])
  transport.getActiveAccount.mockResolvedValue({ env: [] })
  transport.setActiveAccount.mockResolvedValue(undefined)
  transport.renameAccount.mockResolvedValue(undefined)
  transport.deleteAccount.mockResolvedValue(undefined)
})

describe("useAccounts", () => {
  const ACCOUNT: AccountSummary = {
    id: "account-a",
    label: "A",
    provider: "anthropic",
    variant: "anthropic",
    createdAtMs: 1,
    lastUsedAtMs: 1,
    expiresAtMs: 2,
  }

  it("surfaces load failures and allows a retry", async () => {
    transport.listAccounts.mockRejectedValueOnce(new Error("keyring unavailable"))
    const { result } = renderHook(() => useAccounts("anthropic"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toMatch(/keyring unavailable/)

    transport.listAccounts.mockResolvedValueOnce([ACCOUNT])
    await act(async () => result.current.reload())
    expect(result.current.accounts).toEqual([ACCOUNT])
    expect(result.current.error).toBeNull()
  })

  it("reloads when another subscription surface mutates", async () => {
    transport.listAccounts.mockResolvedValueOnce([]).mockResolvedValueOnce([ACCOUNT])
    const { result } = renderHook(() => useAccounts("anthropic"))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => notifySubscriptionChanged())

    await waitFor(() => expect(result.current.accounts).toEqual([ACCOUNT]))
  })

  it("exposes the pending account action and selected replacement", async () => {
    transport.listAccounts.mockResolvedValue([ACCOUNT])
    let finish!: () => void
    transport.deleteAccount.mockImplementation(
      () => new Promise<void>((resolve) => (finish = resolve))
    )
    const { result } = renderHook(() => useAccounts("anthropic"))
    await waitFor(() => expect(result.current.loading).toBe(false))

    let removal!: Promise<void>
    act(() => {
      removal = result.current.remove("account-a", "account-b")
    })
    expect(result.current.pendingAction).toBe("delete")
    expect(result.current.pendingAccountId).toBe("account-a")
    expect(transport.deleteAccount).toHaveBeenCalledWith("anthropic", "account-a", "account-b")

    await act(async () => {
      finish()
      await removal
    })
    expect(result.current.pendingAction).toBeNull()
  })
})

describe("useProviderPresets", () => {
  it("loads the library and resolves the default preset id", async () => {
    const { result } = renderHook(() => useProviderPresets("anthropic"))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.presets).toEqual([PRESET_A, PRESET_B])
    expect(result.current.defaultPresetId).toBe("a")
  })

  it("degrades to empty outside Tauri without calling transport", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useProviderPresets("anthropic"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.presets).toEqual([])
    expect(result.current.defaultPresetId).toBeNull()
    expect(transport.listPresets).not.toHaveBeenCalled()
  })

  it("treats a null resolved default as no default", async () => {
    transport.getProviderPreset.mockResolvedValue(null)
    const { result } = renderHook(() => useProviderPresets("codex"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.defaultPresetId).toBeNull()
  })

  it("upserts a new preset via save (append)", async () => {
    const { result } = renderHook(() => useProviderPresets("anthropic"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const fresh: ProviderPreset = { id: "c", label: "New", baseUrl: "https://c.example" }
    await act(async () => {
      await result.current.save(fresh)
    })
    expect(transport.saveProviderPreset).toHaveBeenCalledWith("anthropic", fresh)
    expect(result.current.presets.map((p) => p.id)).toEqual(["a", "b", "c"])
  })

  it("replaces an existing preset in place via save", async () => {
    const { result } = renderHook(() => useProviderPresets("anthropic"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const edited: ProviderPreset = { ...PRESET_A, label: "Bedrock v2" }
    await act(async () => {
      await result.current.save(edited)
    })
    expect(result.current.presets).toEqual([edited, PRESET_B])
  })

  it("removes a preset and clears the default when it was the default", async () => {
    const { result } = renderHook(() => useProviderPresets("anthropic"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.remove("a")
    })
    expect(transport.deleteProviderPreset).toHaveBeenCalledWith("anthropic", "a")
    expect(result.current.presets).toEqual([PRESET_B])
    expect(result.current.defaultPresetId).toBeNull()
  })

  it("keeps the default when removing a non-default preset", async () => {
    const { result } = renderHook(() => useProviderPresets("anthropic"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.remove("b")
    })
    expect(result.current.defaultPresetId).toBe("a")
  })

  it("sets and clears the default preset id", async () => {
    const { result } = renderHook(() => useProviderPresets("anthropic"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.setDefault("b")
    })
    expect(transport.setDefaultPreset).toHaveBeenCalledWith("anthropic", "b")
    expect(result.current.defaultPresetId).toBe("b")
    await act(async () => {
      await result.current.setDefault(null)
    })
    expect(result.current.defaultPresetId).toBeNull()
  })

  it("reload re-reads the library", async () => {
    const { result } = renderHook(() => useProviderPresets("anthropic"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    transport.listPresets.mockResolvedValue([PRESET_B])
    transport.getProviderPreset.mockResolvedValue(PRESET_B)
    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.presets).toEqual([PRESET_B])
    expect(result.current.defaultPresetId).toBe("b")
  })

  it("reload degrades to empty outside Tauri", async () => {
    const { result } = renderHook(() => useProviderPresets("anthropic"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    isTauriMock.mockReturnValue(false)
    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.presets).toEqual([])
    expect(result.current.defaultPresetId).toBeNull()
  })
})
