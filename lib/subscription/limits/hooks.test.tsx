/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { ProviderLimits } from "@/types/subscription"

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const useLiveQueryMock = jest.fn()
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => useLiveQueryMock() }))

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

const queryAccountLimitsCoalescedMock = jest.fn()
jest.mock("./coalesce", () => ({
  queryAccountLimitsCoalesced: (...a: unknown[]) => queryAccountLimitsCoalescedMock(...a),
}))

const queryAllConfiguredLimitsMock = jest.fn()
jest.mock("./aggregate", () => ({
  queryAllConfiguredLimits: (...a: unknown[]) => queryAllConfiguredLimitsMock(...a),
}))

const recordLimitsSnapshotMock = jest.fn()
jest.mock("./store", () => ({
  recordLimitsSnapshot: (...a: unknown[]) => recordLimitsSnapshotMock(...a),
}))

const saveSettingsMock = jest.fn(async () => {})
let enabledAccounts: string[] = []
jest.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(
    (selector: (state: { settings: unknown; save: typeof saveSettingsMock }) => unknown) =>
      selector({
        settings: { limitsQueryEnabledAccounts: enabledAccounts },
        save: saveSettingsMock,
      }),
    {
      getState: () => ({
        settings: { limitsQueryEnabledAccounts: enabledAccounts, customLimitsSources: [] },
        save: saveSettingsMock,
      }),
    }
  ),
}))

import { useAllConfiguredLimits, useProviderLimits } from "./hooks"

function snap(over: Partial<ProviderLimits> = {}): ProviderLimits {
  return { provider: "anthropic", accountId: "acc-1", fetchedAt: 1000, meters: [], ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  useLiveQueryMock.mockReturnValue(null)
  enabledAccounts = ["anthropic:acc-1", "codex:acc-2"]
})

describe("useProviderLimits", () => {
  it("exposes the live snapshot", () => {
    useLiveQueryMock.mockReturnValue(snap())
    const { result } = renderHook(() => useProviderLimits("anthropic", "acc-1"))
    expect(result.current.snapshot?.accountId).toBe("acc-1")
  })

  it("refreshes: queries the coalescer and persists the result", async () => {
    queryAccountLimitsCoalescedMock.mockResolvedValue(snap())
    const { result } = renderHook(() => useProviderLimits("anthropic", "acc-1"))
    await act(async () => {
      await result.current.refresh()
    })
    // Automatic callers don't force — they share the coalescer's throttle.
    expect(queryAccountLimitsCoalescedMock).toHaveBeenCalledWith("anthropic", "acc-1", {
      force: undefined,
    })
    expect(recordLimitsSnapshotMock).toHaveBeenCalledTimes(1)
    expect(result.current.unavailable).toBe(false)
  })

  it("forwards force so an explicit refresh bypasses the throttle", async () => {
    queryAccountLimitsCoalescedMock.mockResolvedValue(snap())
    const { result } = renderHook(() => useProviderLimits("anthropic", "acc-1"))
    await act(async () => {
      await result.current.refresh({ force: true })
    })
    expect(queryAccountLimitsCoalescedMock).toHaveBeenCalledWith("anthropic", "acc-1", {
      force: true,
    })
  })

  it("marks unavailable when the coalescer returns null", async () => {
    queryAccountLimitsCoalescedMock.mockResolvedValue(null)
    const { result } = renderHook(() => useProviderLimits("anthropic", "acc-1"))
    await act(async () => {
      await result.current.refresh()
    })
    expect(recordLimitsSnapshotMock).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.unavailable).toBe(true))
  })

  it("is a no-op outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useProviderLimits("anthropic", "acc-1"))
    await act(async () => {
      await result.current.refresh()
    })
    expect(queryAccountLimitsCoalescedMock).not.toHaveBeenCalled()
  })

  it("does not query any account until the user opts in", async () => {
    enabledAccounts = []
    const { result } = renderHook(() => useProviderLimits("anthropic", "acc-1"))

    expect(result.current.queryEnabled).toBe(false)
    await act(async () => {
      await result.current.refresh({ force: true })
    })

    expect(queryAccountLimitsCoalescedMock).not.toHaveBeenCalled()
  })

  it("persists an account-scoped opt-in without enabling sibling accounts", async () => {
    enabledAccounts = ["codex:other"]
    const { result } = renderHook(() => useProviderLimits("codex", "acc-1"))

    await act(async () => {
      await result.current.setQueryEnabled(true)
    })

    expect(saveSettingsMock).toHaveBeenCalledWith({
      limitsQueryEnabledAccounts: ["codex:other", "codex:acc-1"],
    })
  })
})

describe("useAllConfiguredLimits", () => {
  it("aggregates and persists each snapshot, routing accounts through the coalescer", async () => {
    queryAllConfiguredLimitsMock.mockImplementation(
      async (deps: { runAccount: (p: string, a: string) => Promise<unknown> }) => {
        // Exercise the injected runAccount so the status-bar/tray → coalescer
        // wiring is covered (the whole point of the 429 fix).
        await deps.runAccount("anthropic", "acc-1")
        return [snap(), snap({ accountId: "acc-2" })]
      }
    )
    const { result } = renderHook(() => useAllConfiguredLimits("anthropic"))
    await act(async () => {
      await result.current.refresh()
    })
    expect(queryAllConfiguredLimitsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activeProvider: "anthropic",
        listCustomSources: expect.any(Function),
        runAccount: expect.any(Function),
      })
    )
    expect(queryAccountLimitsCoalescedMock).toHaveBeenCalledWith("anthropic", "acc-1")
    expect(result.current.snapshots).toHaveLength(2)
    expect(recordLimitsSnapshotMock).toHaveBeenCalledTimes(2)
  })

  it("is a no-op outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useAllConfiguredLimits())
    await act(async () => {
      await result.current.refresh()
    })
    expect(queryAllConfiguredLimitsMock).not.toHaveBeenCalled()
  })

  it("filters every account that has not opted into network quota queries", async () => {
    enabledAccounts = ["codex:acc-2"]
    queryAllConfiguredLimitsMock.mockImplementation(
      async (deps: { runAccount: (p: string, a: string) => Promise<unknown> }) => {
        await deps.runAccount("anthropic", "acc-1")
        await deps.runAccount("codex", "acc-2")
        return []
      }
    )

    const { result } = renderHook(() => useAllConfiguredLimits())
    await act(async () => {
      await result.current.refresh()
    })

    expect(queryAccountLimitsCoalescedMock).toHaveBeenCalledTimes(1)
    expect(queryAccountLimitsCoalescedMock).toHaveBeenCalledWith("codex", "acc-2")
  })
})
