/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import { PetRemoteSnapshotError, type PetRemoteClient } from "@/lib/pet/remote/client"
import type { PetRemoteSnapshot } from "@/lib/pet/remote/types"
import {
  PET_SNAPSHOT_INVALIDATE_COALESCE_MS,
  usePetRemoteSnapshot,
  useRemoteActionCooldown,
  type UsePetRemoteSnapshotDeps,
} from "./use-pet-remote-snapshot"

function snapshot(over: Partial<PetRemoteSnapshot> = {}): PetRemoteSnapshot {
  return {
    availability: { available: true },
    summary: {
      hatched: true,
      name: "Boba",
      level: 3,
      stage: "baby",
      xp: 40,
      mood: "happy",
      needs: { energy: 80, mood: 70, bond: 50 },
      condition: "well",
      coins: 12,
      streak: { days: 2, lastDay: null, multiplier: 1 },
      cooldowns: { fed: 0, played: 4000 },
    },
    presentation: {
      requestedSkinId: "svg",
      desktopVisible: true,
      llmSpeakEnabled: true,
      chatEnabled: true,
    },
    hostTime: 1_000,
    ...over,
  } as PetRemoteSnapshot
}

const getSnapshot = jest.fn<Promise<PetRemoteSnapshot>, []>()
const client = { getSnapshot } as unknown as PetRemoteClient
const handlers = new Set<(payload: unknown) => void>()
const unsubscribe = jest.fn()
// Stable deps: the hook re-subscribes when they change identity.
const deps: UsePetRemoteSnapshotDeps = {
  getClient: () => client,
  subscribe: ((event: string, handler: (payload: unknown) => void) => {
    expect(event).toBe("sync://invalidate")
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
      unsubscribe()
    }
  }) as UsePetRemoteSnapshotDeps["subscribe"],
  now: () => 5_000,
}

beforeEach(() => {
  getSnapshot.mockReset()
  handlers.clear()
  unsubscribe.mockClear()
})

describe("usePetRemoteSnapshot", () => {
  it("asks the desktop on mount and stamps the answer with this device's clock", async () => {
    getSnapshot.mockResolvedValue(snapshot())
    const { result } = renderHook(() => usePetRemoteSnapshot(true, deps))
    expect(result.current.snapshot).toBeUndefined()
    await waitFor(() => expect(result.current.snapshot).toBeDefined())
    expect(result.current.fetchedAt).toBe(5_000)
    expect(result.current.error).toBeNull()
  })

  it("asks nothing while disabled", () => {
    renderHook(() => usePetRemoteSnapshot(false, deps))
    expect(getSnapshot).not.toHaveBeenCalled()
    expect(handlers.size).toBe(0)
  })

  it("keeps the last good snapshot and says why a refresh failed", async () => {
    getSnapshot.mockResolvedValueOnce(snapshot())
    const { result } = renderHook(() => usePetRemoteSnapshot(true, deps))
    await waitFor(() => expect(result.current.snapshot).toBeDefined())

    getSnapshot.mockRejectedValueOnce(new Error("offline"))
    await act(async () => {
      expect(await result.current.refresh()).toBeNull()
    })
    expect(result.current.error).toBe("unreachable")
    expect(result.current.snapshot?.summary?.name).toBe("Boba")

    getSnapshot.mockRejectedValueOnce(new PetRemoteSnapshotError())
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.error).toBe("invalid")
  })

  it("refreshes when the window regains focus or becomes visible", async () => {
    getSnapshot.mockResolvedValue(snapshot())
    renderHook(() => usePetRemoteSnapshot(true, deps))
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(1))
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })
    expect(getSnapshot).toHaveBeenCalledTimes(2)
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(getSnapshot).toHaveBeenCalledTimes(3)
  })

  it("refreshes once per burst of pet-table invalidations and ignores other tables", async () => {
    jest.useFakeTimers()
    try {
      getSnapshot.mockResolvedValue(snapshot())
      renderHook(() => usePetRemoteSnapshot(true, deps))
      await act(async () => {
        await Promise.resolve()
      })
      expect(getSnapshot).toHaveBeenCalledTimes(1)
      const emit = (payload: unknown) => handlers.forEach((handler) => handler(payload))

      emit({ table: "sessions" })
      await act(async () => {
        jest.advanceTimersByTime(PET_SNAPSHOT_INVALIDATE_COALESCE_MS)
      })
      expect(getSnapshot).toHaveBeenCalledTimes(1)

      emit({ table: "petProfile" })
      emit({ table: "petInventory" })
      emit(undefined)
      await act(async () => {
        jest.advanceTimersByTime(PET_SNAPSHOT_INVALIDATE_COALESCE_MS)
      })
      expect(getSnapshot).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it("lets only the newest refresh write", async () => {
    let finishFirst!: (s: PetRemoteSnapshot) => void
    getSnapshot
      .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce(snapshot({ hostTime: 2 }))
    const { result } = renderHook(() => usePetRemoteSnapshot(true, deps))
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.snapshot?.hostTime).toBe(2)
    await act(async () => {
      finishFirst(snapshot({ hostTime: 1 }))
    })
    expect(result.current.snapshot?.hostTime).toBe(2)
  })

  it("stops listening on unmount", () => {
    getSnapshot.mockResolvedValue(snapshot())
    const { unmount } = renderHook(() => usePetRemoteSnapshot(true, deps))
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

describe("useRemoteActionCooldown", () => {
  it("ages the desktop's cooldowns from when the snapshot arrived", () => {
    let clock = 10_000
    const now = () => clock
    const remote = snapshot()
    const { result } = renderHook(() =>
      useRemoteActionCooldown(remote, 10_000, { now, tickMs: 100 })
    )
    expect(result.current.remaining("played")).toBe(4000)
    expect(result.current.remaining("fed")).toBe(0)
    expect(result.current.remaining("unknown")).toBe(0)
    jest.useFakeTimers()
    try {
      const ticking = renderHook(() =>
        useRemoteActionCooldown(remote, 10_000, { now, tickMs: 100 })
      )
      clock = 12_500
      act(() => {
        jest.advanceTimersByTime(100)
      })
      expect(ticking.result.current.remaining("played")).toBe(1500)
      clock = 15_000
      act(() => {
        jest.advanceTimersByTime(100)
      })
      expect(ticking.result.current.remaining("played")).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it("reports nothing cooling before the first snapshot", () => {
    const { result } = renderHook(() => useRemoteActionCooldown(undefined, null))
    expect(result.current.remaining("played")).toBe(0)
  })

  it("never reads longer than the desktop said", () => {
    // `now` predates the snapshot until the ticker first runs.
    const { result } = renderHook(() =>
      useRemoteActionCooldown(snapshot(), 50_000, { now: () => 1_000, tickMs: 60_000 })
    )
    expect(result.current.remaining("played")).toBe(4000)
  })
})
