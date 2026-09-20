jest.mock("./search-service", () => ({
  testProviderConnection: jest.fn(),
  testProviderKeyPool: jest.fn(),
}))

import {
  testProviderConnection as serviceTest,
  testProviderKeyPool as serviceKeyPoolTest,
} from "./search-service"
import { testProviderConnection, testProviderKeyPool } from "./provider-test"
import type { SearchProviderSettings } from "./types"

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

describe("testProviderKeyPool (provider-test.ts)", () => {
  it("delegates to search-service with the full provider settings", async () => {
    const rows = [{ index: 0, ok: true, keyHint: "-key" }]
    ;(serviceKeyPoolTest as jest.Mock).mockResolvedValueOnce(rows)
    const settings: SearchProviderSettings = {
      providerId: "tavily",
      apiKey: "tvly-key",
      apiKeys: ["tvly-backup"],
      enabled: true,
      priority: 1,
    }
    const r = await testProviderKeyPool("tavily", settings)
    expect(r).toBe(rows)
    expect(serviceKeyPoolTest).toHaveBeenCalledWith("tavily", settings)
  })
})
