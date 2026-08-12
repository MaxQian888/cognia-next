/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"

const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const snapshotMock = jest.fn()
jest.mock("@/lib/tauri/fleet", () => ({
  fleetGetSnapshot: () => snapshotMock(),
}))

const canonicalUnlistenMock = jest.fn()
jest.mock("@/lib/claude/ipc", () => ({
  subscribeAgentEvents: () => Promise.resolve(canonicalUnlistenMock),
}))

type Handler = (e: { payload: unknown }) => void
const handlers = new Map<string, Handler>()
const unlistenSpies = new Map<string, jest.Mock>()
let listenCallCount = 0
// When set, `listen` parks its resolve here so a test can unmount mid-subscribe.
let deferListen: ((resume: () => void) => void) | null = null
jest.mock("@tauri-apps/api/event", () => ({
  listen: (topic: string, handler: Handler) => {
    listenCallCount += 1
    handlers.set(topic, handler)
    const un = jest.fn(() => handlers.delete(topic))
    unlistenSpies.set(topic, un)
    if (deferListen) {
      const park = deferListen
      return new Promise<() => void>((resolve) => park(() => resolve(un)))
    }
    return Promise.resolve(un)
  },
}))

import { useFleetStream } from "./use-fleet-stream"
import { fleetStreamStore } from "@/lib/fleet/fleet-stream-store"
import { FLEET_UPDATE_EVENT } from "@/lib/fleet/types"
import { unifiedFleetStore } from "@/lib/fleet/unified-fleet-store"

function snap(generatedAt: number, ids: string[] = []) {
  return {
    generatedAt,
    sessions: ids.map((sessionId) => ({ sessionId })),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  handlers.clear()
  unlistenSpies.clear()
  listenCallCount = 0
  deferListen = null
  isTauriMock.mockReturnValue(true)
  snapshotMock.mockResolvedValue(snap(0))
  // The store is module-level — drop cross-test listener/snapshot state.
  unifiedFleetStore.resetForTests()
  fleetStreamStore.resetForTests()
})

describe("useFleetStream", () => {
  it("is inert off Tauri", () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useFleetStream())
    expect(result.current.available).toBe(false)
    expect(result.current.snapshot.sessions).toEqual([])
    expect(snapshotMock).not.toHaveBeenCalled()
  })

  it("backfills the initial snapshot after subscribing", async () => {
    snapshotMock.mockResolvedValue(snap(100, ["a"]))
    const { result } = renderHook(() => useFleetStream())
    await waitFor(() => expect(result.current.snapshot.generatedAt).toBe(100))
    expect(handlers.has(FLEET_UPDATE_EVENT)).toBe(true)
  })

  it("replaces state on every update event", async () => {
    const { result } = renderHook(() => useFleetStream())
    await waitFor(() => expect(handlers.has(FLEET_UPDATE_EVENT)).toBe(true))
    act(() => handlers.get(FLEET_UPDATE_EVENT)!({ payload: snap(200, ["x", "y"]) }))
    expect(result.current.snapshot.sessions).toHaveLength(2)
    act(() => handlers.get(FLEET_UPDATE_EVENT)!({ payload: snap(300, ["x"]) }))
    expect(result.current.snapshot.sessions).toHaveLength(1)
  })

  it("keeps a newer live update over a stale backfill", async () => {
    let resolveBackfill: (v: unknown) => void = () => {}
    snapshotMock.mockReturnValue(new Promise((r) => (resolveBackfill = r)))
    const { result } = renderHook(() => useFleetStream())
    await waitFor(() => expect(handlers.has(FLEET_UPDATE_EVENT)).toBe(true))
    // Live event lands before the (slow) backfill resolves with older data.
    act(() => handlers.get(FLEET_UPDATE_EVENT)!({ payload: snap(500, ["live"]) }))
    await act(async () => {
      resolveBackfill(snap(400, ["stale"]))
    })
    expect(result.current.snapshot.generatedAt).toBe(500)
  })

  it("unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => useFleetStream())
    await waitFor(() => expect(unlistenSpies.has(FLEET_UPDATE_EVENT)).toBe(true))
    unmount()
    expect(unlistenSpies.get(FLEET_UPDATE_EVENT)).toHaveBeenCalled()
    expect(canonicalUnlistenMock).toHaveBeenCalled()
  })

  it("shares ONE Tauri listener across two concurrent consumers", async () => {
    const a = renderHook(() => useFleetStream())
    const b = renderHook(() => useFleetStream())
    await waitFor(() => expect(handlers.has(FLEET_UPDATE_EVENT)).toBe(true))
    expect(listenCallCount).toBe(1)
    act(() => handlers.get(FLEET_UPDATE_EVENT)!({ payload: snap(50, ["s"]) }))
    expect(a.result.current.snapshot.generatedAt).toBe(50)
    expect(b.result.current.snapshot.generatedAt).toBe(50)
    a.unmount()
    // Listener stays while one consumer remains.
    expect(unlistenSpies.get(FLEET_UPDATE_EVENT)).not.toHaveBeenCalled()
    b.unmount()
    expect(unlistenSpies.get(FLEET_UPDATE_EVENT)).toHaveBeenCalled()
  })

  it("cleans up immediately when unmounted mid-subscribe", async () => {
    // Park listen resolution so we can unmount while the async subscribe is
    // still pending — the store must then unlisten and skip the backfill.
    let resolveListen: (() => void) | undefined
    deferListen = (resolve) => {
      resolveListen = resolve
    }
    const { unmount } = renderHook(() => useFleetStream())
    await waitFor(() => expect(resolveListen).toBeDefined())
    unmount()
    // Now let the listen promise resolve — the attach generation is stale.
    await act(async () => {
      resolveListen!()
    })
    expect(unlistenSpies.get(FLEET_UPDATE_EVENT)).toHaveBeenCalled()
    // Backfill must not run after unmount.
    expect(snapshotMock).not.toHaveBeenCalled()
  })
})
