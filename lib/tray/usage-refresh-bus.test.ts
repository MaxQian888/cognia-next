import { onTrayUsageRefreshRequest, requestTrayUsageRefresh } from "./usage-refresh-bus"

describe("tray usage refresh bus", () => {
  it("notifies subscribers and stops after unsubscribe", () => {
    const listener = jest.fn()
    const off = onTrayUsageRefreshRequest(listener)
    requestTrayUsageRefresh()
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    requestTrayUsageRefresh()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("keeps notifying the remaining listeners when one throws", () => {
    const boom = jest.fn(() => {
      throw new Error("boom")
    })
    const healthy = jest.fn()
    const offBoom = onTrayUsageRefreshRequest(boom)
    const offHealthy = onTrayUsageRefreshRequest(healthy)
    expect(() => requestTrayUsageRefresh()).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(1)
    offBoom()
    offHealthy()
  })
})
