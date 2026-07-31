let handler: ((p: unknown) => void) | undefined
const unsubscribeMock = jest.fn()
const subscribeMock = jest.fn((_event: string, h: (p: unknown) => void) => {
  handler = h
  return unsubscribeMock
})
const callMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  transport: {
    subscribe: (...args: unknown[]) => subscribeMock(...(args as [string, (p: unknown) => void])),
    call: (...args: unknown[]) => callMock(...args),
  },
  isTauri: () => false,
  invoke: jest.fn(),
}))

const hydrateCompanionConfigMock = jest.fn()
jest.mock("@/lib/tauri/transport-companion", () => ({
  hydrateCompanionConfig: () => hydrateCompanionConfigMock(),
}))

import { fleetRemoteStore } from "./fleet-remote-store"

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("fleetRemoteStore", () => {
  beforeEach(() => {
    fleetRemoteStore.resetForTests()
    handler = undefined
    subscribeMock.mockClear()
    unsubscribeMock.mockClear()
    callMock.mockReset()
    callMock.mockResolvedValue({ sessions: [], generatedAt: 0 })
    hydrateCompanionConfigMock.mockReset().mockResolvedValue(null)
  })

  it("subscribes on cold attach and applies a live frame", async () => {
    const notify = jest.fn()
    const unsub = fleetRemoteStore.subscribe(notify)
    await flush()
    expect(subscribeMock).toHaveBeenCalledWith("fleet://update", expect.any(Function))
    handler!({ sessions: [{ sessionId: "a" }], generatedAt: 10 })
    expect(fleetRemoteStore.getSnapshot().generatedAt).toBe(10)
    expect(notify).toHaveBeenCalled()
    unsub()
  })

  it("ignores a stale (older generatedAt) frame", async () => {
    const unsub = fleetRemoteStore.subscribe(jest.fn())
    await flush()
    handler!({ sessions: [], generatedAt: 20 })
    handler!({ sessions: [{ sessionId: "old" }], generatedAt: 5 })
    expect(fleetRemoteStore.getSnapshot().generatedAt).toBe(20)
    unsub()
  })

  it("backfills via fleet_get_snapshot after subscribing", async () => {
    callMock.mockResolvedValue({ sessions: [{ sessionId: "bf" }], generatedAt: 3 })
    const unsub = fleetRemoteStore.subscribe(jest.fn())
    await flush()
    expect(callMock).toHaveBeenCalledWith("fleet_get_snapshot")
    expect(fleetRemoteStore.getSnapshot().generatedAt).toBe(3)
    unsub()
  })

  it("waits for companion config hydration before subscribing and backfilling", async () => {
    let finishHydration: (() => void) | undefined
    hydrateCompanionConfigMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishHydration = resolve
        })
    )

    const unsub = fleetRemoteStore.subscribe(jest.fn())
    expect(subscribeMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()

    finishHydration?.()
    await flush()
    expect(subscribeMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith("fleet_get_snapshot")
    unsub()
  })

  it("shares one subscription and detaches on the last unsubscribe", async () => {
    const unsubA = fleetRemoteStore.subscribe(jest.fn())
    const unsubB = fleetRemoteStore.subscribe(jest.fn())
    await flush()
    expect(subscribeMock).toHaveBeenCalledTimes(1)
    unsubA()
    expect(unsubscribeMock).not.toHaveBeenCalled()
    unsubB()
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it("returns an empty server snapshot", () => {
    expect(fleetRemoteStore.getServerSnapshot()).toEqual({ sessions: [], generatedAt: 0 })
  })
})
