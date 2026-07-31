/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import { act, renderHook, waitFor } from "@testing-library/react"

import { __resetSyncStateForTests, runSyncDown } from "@/lib/sync/companion-sync"

import { useDexieFirstQuery } from "./use-dexie-first-query"

jest.mock("@/lib/sync/companion-sync", () => {
  const actual = jest.requireActual("@/lib/sync/companion-sync")
  return {
    ...actual,
    runSyncDown: jest.fn(actual.runSyncDown),
  }
})

beforeEach(() => {
  __resetSyncStateForTests()
  ;(runSyncDown as jest.Mock).mockClear()
})

describe("useDexieFirstQuery", () => {
  it("returns initial then resolves to the Dexie query result", async () => {
    const { result } = renderHook(() =>
      useDexieFirstQuery<string[]>({
        query: () => ["alpha", "beta"],
        deps: [],
        initial: [],
      })
    )

    await waitFor(() => {
      expect(result.current.data).toEqual(["alpha", "beta"])
    })
    expect(result.current.isSyncing).toBe(false)
    expect(result.current.lastSyncedAt).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it("kicks runSyncDown once on mount, scoped to only the consumer's table", async () => {
    renderHook(() =>
      useDexieFirstQuery<string[]>({
        query: () => [],
        deps: [],
        initial: [],
        table: "characters",
      })
    )

    await waitFor(() => {
      expect(runSyncDown).toHaveBeenCalledTimes(1)
    })
    // The fix: a single-table consumer must not kick a full 10-table pull.
    expect(runSyncDown).toHaveBeenCalledWith({ only: ["characters"] })
  })

  it("does NOT kick runSyncDown when `table` is omitted", async () => {
    renderHook(() =>
      useDexieFirstQuery<string[]>({
        query: () => [],
        deps: [],
        initial: [],
      })
    )
    // Drain pending effects then assert no sync kick happened.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(runSyncDown).not.toHaveBeenCalled()
  })

  it("exposes isSyncing=true while the on-mount sync is in flight", async () => {
    let resolveSync: () => void = () => {}
    ;(runSyncDown as jest.Mock).mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          resolveSync = () => resolve([])
        })
    )

    const { result } = renderHook(() =>
      useDexieFirstQuery<string[]>({
        query: () => [],
        deps: [],
        initial: [],
        table: "characters",
      })
    )

    await waitFor(() => expect(result.current.isSyncing).toBe(true))

    act(() => resolveSync())

    await waitFor(() => expect(result.current.isSyncing).toBe(false))
  })
})
