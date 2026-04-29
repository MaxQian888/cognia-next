jest.mock("./search-service", () => ({
  testProviderConnection: jest.fn(),
}))

import { testProviderConnection as serviceTest } from "./search-service"
import { testProviderConnection } from "./provider-test"

describe("testProviderConnection (provider-test.ts)", () => {
  it("delegates to search-service", async () => {
    ;(serviceTest as jest.Mock).mockResolvedValueOnce(true)
    const r = await testProviderConnection("tavily", "key")
    expect(r).toBe(true)
    expect(serviceTest).toHaveBeenCalledWith("tavily", "key", undefined)
  })

  it("forwards extra settings", async () => {
    ;(serviceTest as jest.Mock).mockResolvedValueOnce(false)
    await testProviderConnection("google", "k", { cx: "abc" })
    expect(serviceTest).toHaveBeenCalledWith("google", "k", { cx: "abc" })
  })
})
