/**
 * @jest-environment jsdom
 */

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
jest.mock("@tauri-apps/api/event", () => ({
  listen: (topic: string, handler: Handler) => {
    handlers.set(topic, handler)
    return Promise.resolve(jest.fn(() => handlers.delete(topic)))
  },
}))

import { fleetStreamStore, EMPTY_FLEET_SNAPSHOT } from "./fleet-stream-store"
import { FLEET_UPDATE_EVENT } from "./types"

const flush = () => new Promise((r) => setTimeout(r, 0))

function snap(generatedAt: number, ids: string[] = []) {
  return { generatedAt, sessions: ids.map((sessionId) => ({ sessionId })) }
}

beforeEach(() => {
  jest.clearAllMocks()
  handlers.clear()
  isTauriMock.mockReturnValue(true)
  snapshotMock.mockResolvedValue(snap(0))
  fleetStreamStore.resetForTests()
})

describe("fleetStreamStore", () => {
  it("starts at the shared empty snapshot", () => {
    expect(fleetStreamStore.getSnapshot()).toBe(EMPTY_FLEET_SNAPSHOT)
    expect(fleetStreamStore.getServerSnapshot()).toBe(EMPTY_FLEET_SNAPSHOT)
  })

  it("listens on FLEET_UPDATE_EVENT and backfills via fleet_get_snapshot", async () => {
    snapshotMock.mockResolvedValue(snap(100, ["a"]))
    const unsub = fleetStreamStore.subscribe(jest.fn())
    await flush()
    expect(handlers.has(FLEET_UPDATE_EVENT)).toBe(true)
    expect(fleetStreamStore.getSnapshot().generatedAt).toBe(100)
    unsub()
  })

  it("keeps a newer live update over a stale backfill (generatedAt guard)", async () => {
    let resolveBackfill: (v: unknown) => void = () => {}
    snapshotMock.mockReturnValue(new Promise((r) => (resolveBackfill = r)))
    const unsub = fleetStreamStore.subscribe(jest.fn())
    await flush()
    handlers.get(FLEET_UPDATE_EVENT)!({ payload: snap(500, ["live"]) })
    resolveBackfill(snap(400, ["stale"]))
    await flush()
    expect(fleetStreamStore.getSnapshot().generatedAt).toBe(500)
    unsub()
  })
})
