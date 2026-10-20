import { notifyCollabScopeChanged, subscribeCollabScopeChanged } from "./scope-events"

describe("collab scope events", () => {
  it("notifies every subscriber until it unsubscribes", () => {
    const first = jest.fn()
    const second = jest.fn()
    const stopFirst = subscribeCollabScopeChanged(first)
    const stopSecond = subscribeCollabScopeChanged(second)

    notifyCollabScopeChanged()
    stopFirst()
    notifyCollabScopeChanged()
    stopSecond()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })

  it("keeps notifying the rest when one subscriber throws", () => {
    const broken = jest.fn(() => {
      throw new Error("boom")
    })
    const healthy = jest.fn()
    const stops = [subscribeCollabScopeChanged(broken), subscribeCollabScopeChanged(healthy)]

    expect(() => notifyCollabScopeChanged()).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(1)
    stops.forEach((stop) => stop())
  })
})
