import {
  createHeartbeatSource,
  wireHeartbeatSource,
  HEARTBEAT_INTERVAL_MS,
} from "./heartbeat-source"

describe("heartbeat-source", () => {
  it("emits an idle tick immediately on wiring", () => {
    const emit = jest.fn()
    const setIv = jest.fn(() => 1 as unknown as ReturnType<typeof setInterval>)
    const clearIv = jest.fn()
    createHeartbeatSource({ setInterval: setIv, clearInterval: clearIv })(emit)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({ source: "system", kind: "idle" })
  })

  it("schedules subsequent idle ticks on the interval and emits on each", () => {
    const emit = jest.fn()
    let scheduled: (() => void) | null = null
    const setIv = jest.fn((fn: () => void) => {
      scheduled = fn
      return 7 as unknown as ReturnType<typeof setInterval>
    })
    const clearIv = jest.fn()

    createHeartbeatSource({ intervalMs: 1000, setInterval: setIv, clearInterval: clearIv })(emit)
    expect(setIv).toHaveBeenCalledWith(expect.any(Function), 1000)

    // Fire two scheduled ticks.
    scheduled!()
    scheduled!()
    expect(emit).toHaveBeenCalledTimes(3) // immediate + two scheduled
    expect(emit).toHaveBeenLastCalledWith({ source: "system", kind: "idle" })
  })

  it("clears the interval on dispose", () => {
    const emit = jest.fn()
    const handle = 42 as unknown as ReturnType<typeof setInterval>
    const setIv = jest.fn(() => handle)
    const clearIv = jest.fn()

    const dispose = createHeartbeatSource({ setInterval: setIv, clearInterval: clearIv })(emit)
    dispose()
    expect(clearIv).toHaveBeenCalledWith(handle)
  })

  it("defaults to a 15-minute cadence and real timers", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(15 * 60_000)
    const spy = jest.spyOn(global, "setInterval")
    const emit = jest.fn()
    const dispose = wireHeartbeatSource(emit)
    expect(spy).toHaveBeenCalledWith(expect.any(Function), HEARTBEAT_INTERVAL_MS)
    expect(emit).toHaveBeenCalledWith({ source: "system", kind: "idle" })
    dispose()
    spy.mockRestore()
  })
})
