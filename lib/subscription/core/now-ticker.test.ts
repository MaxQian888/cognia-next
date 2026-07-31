import { SUBSCRIPTION_TICK_MS, subscriptionNowTicker } from "./now-ticker"

describe("subscriptionNowTicker", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    subscriptionNowTicker.resetForTests()
  })
  afterEach(() => {
    subscriptionNowTicker.resetForTests()
    jest.useRealTimers()
  })

  it("seeds the snapshot on the first subscribe so the first paint is correct", () => {
    jest.setSystemTime(1_000_000)
    expect(subscriptionNowTicker.getSnapshot()).toBe(0)

    const unsubscribe = subscriptionNowTicker.subscribe(() => {})
    expect(subscriptionNowTicker.getSnapshot()).toBe(1_000_000)
    unsubscribe()
  })

  it("notifies every subscriber from ONE interval", () => {
    const a = jest.fn()
    const b = jest.fn()
    const unsubA = subscriptionNowTicker.subscribe(a)
    const unsubB = subscriptionNowTicker.subscribe(b)

    jest.advanceTimersByTime(SUBSCRIPTION_TICK_MS)

    // Both surfaces move together — the whole point, since three independent
    // timers made two countdowns for the same window drift apart.
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    unsubA()
    unsubB()
  })

  it("keeps ticking while at least one subscriber remains", () => {
    const a = jest.fn()
    const b = jest.fn()
    const unsubA = subscriptionNowTicker.subscribe(a)
    const unsubB = subscriptionNowTicker.subscribe(b)

    unsubA()
    jest.advanceTimersByTime(SUBSCRIPTION_TICK_MS)

    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    unsubB()
  })

  it("stops the interval when the last subscriber leaves", () => {
    const listener = jest.fn()
    const unsubscribe = subscriptionNowTicker.subscribe(listener)
    unsubscribe()

    jest.advanceTimersByTime(SUBSCRIPTION_TICK_MS * 3)
    expect(listener).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it("survives StrictMode's mount → unmount → mount without leaking a timer", () => {
    const listener = jest.fn()
    subscriptionNowTicker.subscribe(listener)()
    const unsubscribe = subscriptionNowTicker.subscribe(listener)

    expect(jest.getTimerCount()).toBe(1)
    unsubscribe()
    expect(jest.getTimerCount()).toBe(0)
  })

  it("ignores a disposer called twice", () => {
    const a = jest.fn()
    const b = jest.fn()
    const unsubA = subscriptionNowTicker.subscribe(a)
    const unsubB = subscriptionNowTicker.subscribe(b)

    unsubA()
    unsubA()

    jest.advanceTimersByTime(SUBSCRIPTION_TICK_MS)
    expect(b).toHaveBeenCalledTimes(1)
    unsubB()
  })

  it("reports a stable server snapshot so hydration matches", () => {
    expect(subscriptionNowTicker.getServerSnapshot()).toBe(0)
  })
})
