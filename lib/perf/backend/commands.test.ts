const isTauriMock = jest.fn()
const callMock = jest.fn()
const subscribeMock = jest.fn()

jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
  transport: {
    call: (...args: unknown[]) => callMock(...args),
    subscribe: (...args: unknown[]) => subscribeMock(...args),
  },
}))

import {
  PERF_SAMPLE_EVENT,
  perfHotspots,
  perfListTraces,
  perfOpenTraceDir,
  perfResetHotspots,
  perfSetInterval,
  perfSnapshot,
  perfStartSampling,
  perfStopSampling,
  perfSystemDetails,
  subscribePerfSample,
} from "./commands"

beforeEach(() => {
  isTauriMock.mockReset()
  callMock.mockReset()
  subscribeMock.mockReset()
})

describe("when not in Tauri", () => {
  beforeEach(() => isTauriMock.mockReturnValue(false))

  it("returns inert values without calling transport", async () => {
    expect(await perfSnapshot()).toEqual({ samples: [], running: false, intervalMs: 1000 })
    expect(await perfHotspots()).toEqual([])
    expect(await perfListTraces()).toEqual([])
    expect(await perfSystemDetails()).toBeNull()
    await perfStartSampling(500)
    await perfStopSampling()
    await perfSetInterval(2000)
    await perfResetHotspots()
    await perfOpenTraceDir()
    expect(callMock).not.toHaveBeenCalled()
  })

  it("subscribePerfSample returns a no-op unsubscribe", () => {
    const unsub = subscribePerfSample(() => {})
    expect(typeof unsub).toBe("function")
    expect(subscribeMock).not.toHaveBeenCalled()
    expect(() => unsub()).not.toThrow()
  })
})

describe("when in Tauri", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true)
    callMock.mockResolvedValue(undefined)
  })

  it("perfSnapshot calls the command", async () => {
    callMock.mockResolvedValueOnce({ samples: [], running: true, intervalMs: 1000 })
    const snap = await perfSnapshot()
    expect(callMock).toHaveBeenCalledWith("perf_snapshot")
    expect(snap.running).toBe(true)
  })

  it("perfStartSampling passes the interval", async () => {
    await perfStartSampling(2000)
    expect(callMock).toHaveBeenCalledWith("perf_start_sampling", { intervalMs: 2000 })
  })

  it("perfSetInterval / stop / reset / hotspots / traces / system / open call their commands", async () => {
    await perfSetInterval(4000)
    expect(callMock).toHaveBeenCalledWith("perf_set_interval", { intervalMs: 4000 })
    await perfStopSampling()
    expect(callMock).toHaveBeenCalledWith("perf_stop_sampling")
    await perfResetHotspots()
    expect(callMock).toHaveBeenCalledWith("perf_reset_hotspots")

    callMock.mockResolvedValueOnce([])
    await perfHotspots()
    expect(callMock).toHaveBeenCalledWith("perf_hotspots")

    callMock.mockResolvedValueOnce([])
    await perfListTraces()
    expect(callMock).toHaveBeenCalledWith("perf_list_traces")

    callMock.mockResolvedValueOnce({ os: "x" })
    await perfSystemDetails()
    expect(callMock).toHaveBeenCalledWith("perf_system_details")

    await perfOpenTraceDir()
    expect(callMock).toHaveBeenCalledWith("perf_open_trace_dir")
  })

  it("subscribePerfSample wires transport.subscribe to the event", () => {
    const unsub = jest.fn()
    subscribeMock.mockReturnValue(unsub)
    const handler = jest.fn()
    const result = subscribePerfSample(handler)
    expect(subscribeMock).toHaveBeenCalledWith(PERF_SAMPLE_EVENT, handler)
    expect(result).toBe(unsub)
  })
})
