import { getActiveRuntime, setActiveRuntime, subscribeActiveRuntime } from "./active"
import type { GovernanceRuntime } from "./runtime"

describe("active runtime", () => {
  it("is set, observed and cleared", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeActiveRuntime(listener)
    const runtime = {} as GovernanceRuntime
    setActiveRuntime(runtime)
    expect(getActiveRuntime()).toBe(runtime)
    setActiveRuntime(null)
    expect(getActiveRuntime()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    setActiveRuntime(runtime)
    expect(listener).toHaveBeenCalledTimes(2)
    setActiveRuntime(null)
  })
})
