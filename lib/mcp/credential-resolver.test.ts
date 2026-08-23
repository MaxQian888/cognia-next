/** @jest-environment node */
import type { McpServer } from "@cognia/agent-config-types"

import { resolveMcpRuntimeCredential } from "./credential-resolver"

const server = (transport: McpServer["transport"] = "http") =>
  ({
    id: "server-id",
    name: "Remote",
    transport,
    config: { url: "https://mcp.example.com/mcp", headers: { "X-Tenant": "one" } },
    credentialVersion: 2,
  }) as McpServer

describe("MCP runtime credential resolver", () => {
  it("leaves stdio and non-desktop servers untouched", async () => {
    const loadEntry = jest.fn()
    await expect(
      resolveMcpRuntimeCredential(server("stdio"), { isDesktop: () => true, loadEntry })
    ).resolves.toEqual({ server: server("stdio") })
    await expect(
      resolveMcpRuntimeCredential(server(), { isDesktop: () => false, loadEntry })
    ).resolves.toEqual({ server: server() })
    expect(loadEntry).not.toHaveBeenCalled()
  })

  it("injects a partitioned token locally and preserves configured headers", async () => {
    const loadEntry = jest.fn(async () => ({ accessToken: "secret", expiresAtMs: 100_000 }))
    const resolved = await resolveMcpRuntimeCredential(server(), {
      isDesktop: () => true,
      now: () => 1,
      loadEntry,
    })
    expect(loadEntry).toHaveBeenCalledWith("server-id", "Remote", {
      transport: "http",
      config: server().config,
    })
    expect(resolved.server.config.headers).toEqual({
      "X-Tenant": "one",
      Authorization: "Bearer secret",
    })
  })

  it("preemptively refreshes near-expiry credentials", async () => {
    const refresh = jest.fn(async () => ({ accessToken: "new", expiresAtMs: 100_000 }))
    const resolved = await resolveMcpRuntimeCredential(server(), {
      isDesktop: () => true,
      now: () => 50_000,
      loadEntry: async () => ({ accessToken: "old", expiresAtMs: 50_001 }),
      refresh,
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect((resolved.server.config.headers as Record<string, string>).Authorization).toBe(
      "Bearer new"
    )
  })

  it("provides an explicit-401 refresh that advances the lease fingerprint", async () => {
    const refresh = jest.fn(async () => ({ accessToken: "new" }))
    const resolved = await resolveMcpRuntimeCredential(server(), {
      isDesktop: () => true,
      loadEntry: async () => ({ accessToken: "old" }),
      refresh,
    })
    const retried = await resolved.refreshAuth?.()
    expect(retried?.server.credentialVersion).toBe(3)
    expect((retried?.server.config.headers as Record<string, string>).Authorization).toBe(
      "Bearer new"
    )
  })
})
