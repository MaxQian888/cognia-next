import {
  createSilenceWatchdog,
  DEFAULT_SILENCE_TIMEOUT_MS,
  type SilenceWatchdog,
} from "./silence-watchdog"

describe("createSilenceWatchdog", () => {
  let silent: jest.Mock
  let recovered: jest.Mock
  let watchdog: SilenceWatchdog

  beforeEach(() => {
    jest.useFakeTimers()
    silent = jest.fn()
    recovered = jest.fn()
    watchdog = createSilenceWatchdog({ timeoutMs: 1_000, onSilent: silent, onRecovered: recovered })
  })

  afterEach(() => {
    watchdog.dispose()
    jest.useRealTimers()
  })

  it("flags a turn that says nothing for the whole budget", () => {
    watchdog.arm("s1")
    jest.advanceTimersByTime(999)
    expect(silent).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    expect(silent).toHaveBeenCalledWith("s1", 1_000)
    expect(watchdog.isSilent("s1")).toBe(true)
  })

  it("does not flag a turn that keeps producing frames", () => {
    watchdog.arm("s1")
    for (let i = 0; i < 10; i += 1) {
      jest.advanceTimersByTime(900)
      watchdog.notice("s1")
    }
    jest.advanceTimersByTime(900)
    expect(silent).not.toHaveBeenCalled()
  })

  it("clears the warning by itself when the turn speaks again", () => {
    watchdog.arm("s1")
    jest.advanceTimersByTime(1_000)
    expect(silent).toHaveBeenCalledTimes(1)

    watchdog.notice("s1")
    expect(recovered).toHaveBeenCalledWith("s1")
    expect(watchdog.isSilent("s1")).toBe(false)

    // …and the clock is running again, so a second stretch is caught too.
    jest.advanceTimersByTime(1_000)
    expect(silent).toHaveBeenCalledTimes(2)
  })

  it("raises the warning once per silent stretch, not once per tick", () => {
    watchdog.arm("s1")
    jest.advanceTimersByTime(10_000)
    expect(silent).toHaveBeenCalledTimes(1)
  })

  it("keeps the flag when an already-silent turn is re-armed", () => {
    // Re-arming an open turn must not clear a warning nothing has answered.
    watchdog.arm("s1")
    jest.advanceTimersByTime(1_000)
    watchdog.arm("s1")
    expect(recovered).not.toHaveBeenCalled()
    expect(watchdog.isSilent("s1")).toBe(true)
  })

  it("clears the warning when the turn ends while flagged", () => {
    watchdog.arm("s1")
    jest.advanceTimersByTime(1_000)
    watchdog.disarm("s1")
    expect(recovered).toHaveBeenCalledWith("s1")
    expect(watchdog.isSilent("s1")).toBe(false)
    jest.advanceTimersByTime(10_000)
    expect(silent).toHaveBeenCalledTimes(1)
  })

  it("stays quiet after a turn that ended before the budget elapsed", () => {
    watchdog.arm("s1")
    jest.advanceTimersByTime(500)
    watchdog.disarm("s1")
    expect(recovered).not.toHaveBeenCalled()
    jest.advanceTimersByTime(10_000)
    expect(silent).not.toHaveBeenCalled()
  })

  it("ignores a late frame on a settled turn instead of starting a clock", () => {
    // A `notice` with no armed turn used to be the obvious place to arm one.
    // It must not: the turn is over, and a clock started here would eventually
    // flag a session that is running nothing.
    watchdog.notice("never-armed")
    jest.advanceTimersByTime(10_000)
    expect(silent).not.toHaveBeenCalled()
    expect(watchdog.isSilent("never-armed")).toBe(false)
  })

  it("tracks sessions independently", () => {
    watchdog.arm("s1")
    watchdog.arm("s2")
    jest.advanceTimersByTime(900)
    watchdog.notice("s2")
    jest.advanceTimersByTime(100)
    expect(silent).toHaveBeenCalledTimes(1)
    expect(silent).toHaveBeenCalledWith("s1", 1_000)
    expect(watchdog.isSilent("s2")).toBe(false)
  })

  it("stops every clock on dispose without reporting recovery", () => {
    watchdog.arm("s1")
    jest.advanceTimersByTime(1_000)
    watchdog.dispose()
    expect(recovered).not.toHaveBeenCalled()
    jest.advanceTimersByTime(10_000)
    expect(silent).toHaveBeenCalledTimes(1)
  })

  it("defaults to a budget long enough not to fire on a slow tool call", () => {
    // 90s is the number the hint quotes; a shorter default would make the
    // warning routine, and a routine warning is ignored.
    expect(DEFAULT_SILENCE_TIMEOUT_MS).toBe(90_000)
  })
})
