import type { McpServer } from "@cognia/agent-config-types"

const mockLoadEntry = jest.fn()
const mockRefresh = jest.fn()
jest.mock("@/lib/mcp/oauth-tauri", () => ({
  mcpOAuthLoadEntry: (...args: unknown[]) => mockLoadEntry(...args),
  mcpOAuthRefresh: (...args: unknown[]) => mockRefresh(...args),
}))
const mockResolveSecrets = jest.fn(async (config: Record<string, unknown>) => ({
  ...config,
  headers: { "X-Key": "resolved" },
}))
jest.mock("@/lib/mcp/credentials", () => ({
  ...jest.requireActual("@/lib/mcp/credentials"),
  resolveMcpSecrets: (config: Record<string, unknown>) => mockResolveSecrets(config),
}))

import { buildRunMcpServerMap } from "./run-server-map"

const remote = {
  id: "srv-1",
  name: "remote",
  transport: "http",
  config: { url: "https://mcp.example", headers: { "X-Key": { secretRef: "k" } } },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
} as unknown as McpServer

describe("buildRunMcpServerMap", () => {
  beforeEach(() => {
    mockLoadEntry.mockReset()
    mockRefresh.mockReset()
    mockResolveSecrets.mockClear()
  })

  it("resolves SecretRefs without OAuth off the desktop", async () => {
    const map = await buildRunMcpServerMap([remote], { isTauri: () => false })
    expect(map.remote).toMatchObject({ type: "http", headers: { "X-Key": "resolved" } })
    expect(mockLoadEntry).not.toHaveBeenCalled()
  })

  it("injects the server's stored OAuth bearer on the desktop, looked up by stable id", async () => {
    mockLoadEntry.mockResolvedValue({ accessToken: "tok" })
    const map = await buildRunMcpServerMap([remote], { isTauri: () => true })
    expect(map.remote).toMatchObject({
      headers: { "X-Key": "resolved", Authorization: "Bearer tok" },
    })
    expect(mockLoadEntry).toHaveBeenCalledWith("srv-1", "remote", {
      transport: "http",
      config: remote.config,
    })
  })

  it("refreshes a near-expiry token through the matching server", async () => {
    mockLoadEntry.mockResolvedValue({ accessToken: "old", expiresAtMs: Date.now() + 1_000 })
    mockRefresh.mockResolvedValue({ accessToken: "new" })
    const map = await buildRunMcpServerMap([remote], { isTauri: () => true })
    expect(mockRefresh).toHaveBeenCalledWith("srv-1", {
      transport: "http",
      config: remote.config,
    })
    expect(map.remote).toMatchObject({ headers: { Authorization: "Bearer new" } })
  })
})
