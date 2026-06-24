import {
  subscribeSubscriptionChanged,
  notifySubscriptionChanged,
  __resetSubscriptionEventsForTesting,
} from "./subscription-events"

afterEach(() => {
  __resetSubscriptionEventsForTesting()
})

describe("subscription-events", () => {
  it("invokes every subscriber on notify", () => {
    const a = jest.fn()
    const b = jest.fn()
    subscribeSubscriptionChanged(a)
    subscribeSubscriptionChanged(b)

    notifySubscriptionChanged()

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it("stops notifying after unsubscribe", () => {
    const a = jest.fn()
    const unsub = subscribeSubscriptionChanged(a)

    notifySubscriptionChanged()
    unsub()
    notifySubscriptionChanged()

    expect(a).toHaveBeenCalledTimes(1)
  })

  it("isolates a throwing listener from the rest", () => {
    const boom = jest.fn(() => {
      throw new Error("nope")
    })
    const ok = jest.fn()
    subscribeSubscriptionChanged(boom)
    subscribeSubscriptionChanged(ok)

    expect(() => notifySubscriptionChanged()).not.toThrow()
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it("tolerates a listener unsubscribing during dispatch", () => {
    const a = jest.fn()
    const unsubB = jest.fn()
    const b = jest.fn(() => unsubB())
    subscribeSubscriptionChanged(() => {
      a()
    })
    const unsub = subscribeSubscriptionChanged(() => {
      b()
      unsub()
    })

    expect(() => notifySubscriptionChanged()).not.toThrow()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it("__resetSubscriptionEventsForTesting clears all subscribers", () => {
    const a = jest.fn()
    subscribeSubscriptionChanged(a)
    __resetSubscriptionEventsForTesting()
    notifySubscriptionChanged()
    expect(a).not.toHaveBeenCalled()
  })
})
