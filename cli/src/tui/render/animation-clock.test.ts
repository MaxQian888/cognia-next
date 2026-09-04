/** @jest-environment node */
import { AnimationClock } from "./animation-clock"

describe("AnimationClock", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("runs one timer per cadence no matter how many subscribers", () => {
    const clock = new AnimationClock()
    const a = jest.fn()
    const b = jest.fn()
    const stopA = clock.subscribe(80, a)
    const stopB = clock.subscribe(80, b)
    expect(clock.timerCount).toBe(1)
    jest.advanceTimersByTime(80)
    // The point of sharing: both saw the same frame, so they cannot drift apart.
    expect(a).toHaveBeenCalledWith(1)
    expect(b).toHaveBeenCalledWith(1)
    stopA()
    stopB()
  })

  it("keeps different cadences on their own timers", () => {
    const clock = new AnimationClock()
    const fast = jest.fn()
    const slow = jest.fn()
    clock.subscribe(80, fast)
    clock.subscribe(320, slow)
    expect(clock.timerCount).toBe(2)
    jest.advanceTimersByTime(320)
    expect(fast).toHaveBeenCalledTimes(4)
    expect(slow).toHaveBeenCalledTimes(1)
    clock.stopAll()
  })

  it("stops the timer when the last subscriber leaves, and restarts from frame 0", () => {
    const clock = new AnimationClock()
    const stop = clock.subscribe(80, jest.fn())
    jest.advanceTimersByTime(240)
    expect(clock.tick(80)).toBe(3)
    stop()
    expect(clock.timerCount).toBe(0)
    // A resting session must cost nothing, and the next animation should open on
    // its first frame rather than wherever the previous one happened to stop.
    expect(clock.tick(80)).toBe(0)
    const again = jest.fn()
    clock.subscribe(80, again)
    jest.advanceTimersByTime(80)
    expect(again).toHaveBeenCalledWith(1)
    clock.stopAll()
  })

  it("keeps ticking the other subscribers when one unsubscribes", () => {
    const clock = new AnimationClock()
    const stay = jest.fn()
    clock.subscribe(80, stay)
    const stop = clock.subscribe(80, jest.fn())
    stop()
    jest.advanceTimersByTime(80)
    expect(stay).toHaveBeenCalledWith(1)
    expect(clock.timerCount).toBe(1)
    clock.stopAll()
  })

  it("survives a listener that unsubscribes from inside its own tick", () => {
    const clock = new AnimationClock()
    const later = jest.fn()
    const stop = clock.subscribe(80, () => stop())
    clock.subscribe(80, later)
    expect(() => jest.advanceTimersByTime(80)).not.toThrow()
    expect(later).toHaveBeenCalledWith(1)
    clock.stopAll()
  })

  it("does not hold the process open", () => {
    const clock = new AnimationClock()
    const unref = jest.fn()
    const spy = jest.spyOn(global, "setInterval").mockReturnValue({ unref } as never)
    clock.subscribe(80, jest.fn())
    expect(unref).toHaveBeenCalled()
    spy.mockRestore()
    clock.stopAll()
  })
})
