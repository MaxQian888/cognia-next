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

type Handler = (e: { payload: unknown }) => void
const handlers = new Map<string, Handler>()
const unlistenSpies = new Map<string, jest.Mock>()
// When set, `listen` parks its resolve here so a test can unmount mid-subscribe.
let deferListen: ((un: () => void) => void) | null = null
jest.mock("@tauri-apps/api/event", () => ({
  listen: (topic: string, handler: Handler) => {
    handlers.set(topic, handler)
    const un = jest.fn(() => handlers.delete(topic))
    unlistenSpies.set(topic, un)
    if (deferListen) {
      const resolveWith = deferListen
      return new Promise<() => void>((resolve) => resolveWith(() => resolve(un)))
    }
    return Promise.resolve(un)
  },
}))

import { useFleetStream } from "./use-fleet-stream"
import { FLEET_UPDATE_EVENT } from "@/lib/fleet/types"

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
  deferListen = null
  isTauriMock.mockReturnValue(true)
  snapshotMock.mockResolvedValue(snap(0))
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
  })

  it("cleans up immediately when unmounted mid-subscribe", async () => {
    // Park listen resolution so we can unmount while the async subscribe is
    // still pending — the effect must then unlisten and skip the backfill.
    let resolveListen: (() => void) | undefined
    deferListen = (resolve) => {
      resolveListen = resolve
    }
    const { unmount } = renderHook(() => useFleetStream())
    await waitFor(() => expect(resolveListen).toBeDefined())
    unmount()
    // Now let the listen promise resolve — aliveRef is already false.
    await act(async () => {
      resolveListen!()
    })
    expect(unlistenSpies.get(FLEET_UPDATE_EVENT)).toHaveBeenCalled()
    // Backfill must not run after unmount.
    expect(snapshotMock).not.toHaveBeenCalled()
  })
})
