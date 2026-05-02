jest.mock("@/lib/native/utils", () => ({
  isTauri: () => true,
}))

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

jest.mock("@/lib/network/proxy-fetch", () => ({
  proxyFetch: (...args: unknown[]) =>
    (global.fetch as jest.MockedFunction<typeof fetch>)(...(args as Parameters<typeof fetch>)),
}))

import { invoke } from "@tauri-apps/api/core"
import { PluginMarketplace } from "./marketplace"

global.fetch = jest.fn()
const mockFetch = global.fetch as jest.Mock
const mockInvoke = invoke as jest.MockedFunction<typeof invoke>

describe("PluginMarketplace install descriptor", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns a normalized descriptor after successful desktop install", async () => {
    const marketplace = new PluginMarketplace()

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "test-plugin",
          name: "Test Plugin",
          description: "A test plugin",
          version: "1.0.0",
          latestVersion: "1.0.0",
          downloads: 0,
          rating: 0,
          ratingCount: 0,
          tags: [],
          categories: [],
          manifest: {
            id: "test-plugin",
            name: "Test Plugin",
            version: "1.0.0",
            description: "A test plugin",
            type: "frontend",
            capabilities: ["tools"],
            main: "dist/index.js",
          },
          publishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          verified: true,
          featured: false,
        }),
    })

    mockInvoke
      .mockResolvedValueOnce([
        {
          version: "1.0.0",
          publishedAt: new Date().toISOString(),
          downloadUrl: "https://example.com/test-plugin.zip",
        },
      ])
      .mockResolvedValueOnce("/plugins")
      .mockResolvedValueOnce(undefined)

    const result = await marketplace.installPlugin("test-plugin")

    expect(result.success).toBe(true)
    expect(result.descriptor).toEqual(
      expect.objectContaining({
        id: "test-plugin",
        source: "marketplace",
        resolvedPath: expect.stringContaining("/plugins"),
        installRoot: expect.objectContaining({ kind: "installed" }),
      })
    )
  })
})
