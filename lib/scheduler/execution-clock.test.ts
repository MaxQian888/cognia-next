import { holdExecutionClock, startExecutionClock } from "./execution-clock"

describe("execution clock", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("aborts with its reason once the timeout passes", () => {
    const controller = new AbortController()
    startExecutionClock(controller, 1_000)
    jest.advanceTimersByTime(999)
    expect(controller.signal.aborted).toBe(false)
    jest.advanceTimersByTime(1)
    expect(controller.signal.reason).toBe("execution-timeout")
  })

  it("does not charge held time and resumes with what was left", () => {
    const controller = new AbortController()
    startExecutionClock(controller, 1_000)
    jest.advanceTimersByTime(400)
    const release = holdExecutionClock(controller.signal)
    jest.advanceTimersByTime(60_000)
    expect(controller.signal.aborted).toBe(false)
    release()
    jest.advanceTimersByTime(599)
    expect(controller.signal.aborted).toBe(false)
    jest.advanceTimersByTime(1)
    expect(controller.signal.aborted).toBe(true)
  })

  it("stays stopped until the last of several holds is released, and a release is single-use", () => {
    const controller = new AbortController()
    startExecutionClock(controller, 1_000)
    const first = holdExecutionClock(controller.signal)
    const second = holdExecutionClock(controller.signal)
    first()
    first()
    jest.advanceTimersByTime(5_000)
    expect(controller.signal.aborted).toBe(false)
    second()
    jest.advanceTimersByTime(1_000)
    expect(controller.signal.aborted).toBe(true)
  })

  it("never fires once cleared, and forgets the signal", () => {
    const controller = new AbortController()
    const clock = startExecutionClock(controller, 1_000)
    clock.clear()
    jest.advanceTimersByTime(5_000)
    expect(controller.signal.aborted).toBe(false)
    // Holding a cleared clock is harmless.
    expect(() => holdExecutionClock(controller.signal)()).not.toThrow()
  })

  it("treats a non-positive timeout as none and an unknown signal as unclocked", () => {
    const controller = new AbortController()
    startExecutionClock(controller, 0)
    jest.advanceTimersByTime(60_000)
    expect(controller.signal.aborted).toBe(false)
    expect(() => holdExecutionClock(new AbortController().signal)()).not.toThrow()
    expect(() => holdExecutionClock(undefined)()).not.toThrow()
  })
})
