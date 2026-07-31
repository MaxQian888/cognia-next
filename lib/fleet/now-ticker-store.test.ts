import { nowTickerStore } from "./now-ticker-store"

describe("nowTickerStore", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    nowTickerStore.resetForTests()
  })
  afterEach(() => {
    nowTickerStore.resetForTests()
    jest.useRealTimers()
  })

  it("exposes a stable server snapshot of 0", () => {
    expect(nowTickerStore.getServerSnapshot()).toBe(0)
  })

  it("is 0 until the first subscriber attaches", () => {
    expect(nowTickerStore.getSnapshot()).toBe(0)
  })

  it("seeds the current time on cold subscribe and ticks each second", () => {
    jest.setSystemTime(10_000)
    const notify = jest.fn()
    const unsub = nowTickerStore.subscribe(notify)
    // Seeded immediately so the first paint is already correct.
    expect(nowTickerStore.getSnapshot()).toBe(10_000)
    // advanceTimersByTime moves both the interval and Date.now() forward.
    jest.advanceTimersByTime(1_000)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(nowTickerStore.getSnapshot()).toBe(11_000)
    unsub()
  })

  it("shares one interval across subscribers and stops on the last unsubscribe", () => {
    jest.setSystemTime(0)
    const a = jest.fn()
    const b = jest.fn()
    const unsubA = nowTickerStore.subscribe(a)
    const unsubB = nowTickerStore.subscribe(b)
    // One shared interval, not one per subscriber.
    expect(jest.getTimerCount()).toBe(1)

    jest.advanceTimersByTime(1_000)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)

    // First unsubscribe keeps ticking for the remaining subscriber.
    unsubA()
    expect(jest.getTimerCount()).toBe(1)
    jest.advanceTimersByTime(1_000)
    expect(b).toHaveBeenCalledTimes(2)

    // Last unsubscribe clears the interval — no further ticks.
    unsubB()
    expect(jest.getTimerCount()).toBe(0)
    const frozen = nowTickerStore.getSnapshot()
    jest.advanceTimersByTime(5_000)
    expect(nowTickerStore.getSnapshot()).toBe(frozen)
    expect(b).toHaveBeenCalledTimes(2)
  })

  it("is idempotent when a teardown runs twice", () => {
    const notify = jest.fn()
    const unsub = nowTickerStore.subscribe(notify)
    unsub()
    unsub() // second call is a no-op, must not throw or double-detach
    expect(jest.getTimerCount()).toBe(0)
  })
})
