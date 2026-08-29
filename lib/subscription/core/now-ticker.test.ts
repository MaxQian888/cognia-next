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

  it("seeds the snapshot on the first READ so the first paint is correct", () => {
    // React reads the snapshot during the initial render and only subscribes
    // afterwards, in an effect. Seeding on subscribe therefore handed that
    // first render a clock of 0 — and a countdown resolved against epoch 0
    // renders as a 1970 date, not as an obviously-missing value.
    jest.setSystemTime(1_000_000)
    expect(subscriptionNowTicker.getSnapshot()).toBe(1_000_000)

    const unsubscribe = subscriptionNowTicker.subscribe(() => {})
    expect(subscriptionNowTicker.getSnapshot()).toBe(1_000_000)
    unsubscribe()
  })

  it("returns a stable snapshot across reads within one render", () => {
    jest.setSystemTime(1_000_000)
    const first = subscriptionNowTicker.getSnapshot()
    jest.setSystemTime(2_000_000)
    // The store contract requires a cached value: re-reading the wall clock
    // here would make every render see a new snapshot and loop forever.
    expect(subscriptionNowTicker.getSnapshot()).toBe(first)
  })

  it("re-seeds after a reset", () => {
    jest.setSystemTime(1_000_000)
    expect(subscriptionNowTicker.getSnapshot()).toBe(1_000_000)
    subscriptionNowTicker.resetForTests()
    jest.setSystemTime(3_000_000)
    expect(subscriptionNowTicker.getSnapshot()).toBe(3_000_000)
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
