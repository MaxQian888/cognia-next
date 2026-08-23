import type { KeyringStore } from "@/lib/credentials/keyring-store"
import type { McpServer } from "@cognia/agent-config-types"

import {
  deleteMcpCredentials,
  externalizeMcpSecrets,
  redactMcpServerForExport,
  resolveMcpSecrets,
} from "./credentials"

function memoryStore(): KeyringStore {
  const values = new Map<string, string>()
  return {
    save: async (key, value) => void values.set(key, value),
    load: async (key) => values.get(key) ?? null,
    delete: async (key) => void values.delete(key),
  }
}

const base = (config: Record<string, unknown>): McpServer =>
  ({
    id: "mcp_a",
    name: "github",
    transport: "stdio",
    config,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }) as McpServer

describe("MCP credential externalization", () => {
  it("moves sensitive env values to stable server-id keyring references", async () => {
    const store = memoryStore()
    const result = await externalizeMcpSecrets(
      base({ command: "node", env: { GITHUB_TOKEN: "top-secret", LOG_LEVEL: "debug" } }),
      store
    )
    expect(result.migrated).toBe(1)
    expect(result.server.config).toEqual({
      command: "node",
      env: {
        GITHUB_TOKEN: { secretRef: "mcp/mcp_a/env/GITHUB_TOKEN" },
        LOG_LEVEL: "debug",
      },
    })
    await expect(resolveMcpSecrets(result.server.config, store)).resolves.toEqual({
      command: "node",
      env: { GITHUB_TOKEN: "top-secret", LOG_LEVEL: "debug" },
    })
  })

  it("detects authorization headers, sensitive args, and credential-bearing URLs", async () => {
    const store = memoryStore()
    const http = base({
      url: "https://user:pass@example.com/mcp?access_token=abc",
      headers: { Authorization: "Bearer abc", Accept: "application/json" },
    })
    http.transport = "http"
    const remote = await externalizeMcpSecrets(http, store)
    expect(remote.migrated).toBe(2)

    const stdio = await externalizeMcpSecrets(
      base({ command: "tool", args: ["--token=abc", "--verbose"] }),
      store
    )
    expect(stdio.migrated).toBe(1)
  })

  it("externalizes the value after a separated sensitive CLI flag", async () => {
    const store = memoryStore()
    const result = await externalizeMcpSecrets(
      base({ command: "tool", args: ["--token", "top-secret", "--verbose"] }),
      store
    )

    expect(result.migrated).toBe(1)
    expect(result.server.config).toEqual({
      command: "tool",
      args: ["--token", { secretRef: "mcp/mcp_a/args/1" }, "--verbose"],
    })
    await expect(resolveMcpSecrets(result.server.config, store)).resolves.toEqual({
      command: "tool",
      args: ["--token", "top-secret", "--verbose"],
    })
  })

  it("fails resolution when a referenced credential is unavailable", async () => {
    await expect(
      resolveMcpSecrets(
        { command: "node", env: { TOKEN: { secretRef: "mcp/missing" } } },
        memoryStore()
      )
    ).rejects.toThrow("credential is unavailable")
  })

  it("redacts unmigrated legacy values in backups and emits a missing-credential manifest", () => {
    const result = redactMcpServerForExport(
      base({ command: "tool", env: { API_KEY: "raw-secret", COLOR: "blue" } })
    )
    expect(result.server.config).toEqual({
      command: "tool",
      env: { API_KEY: { secretRef: "mcp/mcp_a/env/API_KEY" }, COLOR: "blue" },
    })
    expect(result.references).toEqual(["mcp/mcp_a/env/API_KEY"])
  })

  it("redacts separated CLI secret values without replacing their flags", () => {
    const result = redactMcpServerForExport(
      base({ command: "tool", args: ["--api-key", "raw-secret", "--verbose"] })
    )

    expect(result.server.config).toEqual({
      command: "tool",
      args: ["--api-key", { secretRef: "mcp/mcp_a/args/1" }, "--verbose"],
    })
    expect(result.references).toEqual(["mcp/mcp_a/args/1"])
  })

  it("deletes every referenced credential during terminal cleanup", async () => {
    const store = memoryStore()
    const externalized = await externalizeMcpSecrets(
      base({ command: "tool", env: { API_KEY: "secret" }, args: ["--token", "other"] }),
      store
    )
    await expect(deleteMcpCredentials(externalized.server, store)).resolves.toBe(2)
    await expect(resolveMcpSecrets(externalized.server.config, store)).rejects.toThrow(
      /unavailable/
    )
  })
})
