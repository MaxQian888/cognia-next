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

  it("vaults vendor-prefixed API key names in URLs, args, env and headers", async () => {
    // Stagehand's hosted endpoint takes `?modelApiKey=`, its CLI takes
    // `--modelApiKey`; the segment-bounded patterns alone missed both.
    const store = memoryStore()
    const hosted = base({
      url: "https://mcp.browserbase.com/mcp?modelName=gpt-4o&modelApiKey=sk-secret",
      headers: { browserbaseApiKey: "bb-secret", Accept: "application/json" },
    })
    hosted.transport = "http"
    const remote = await externalizeMcpSecrets(hosted, store)
    expect(remote.migrated).toBe(2)
    expect(remote.server.config).toEqual({
      url: { secretRef: "mcp/mcp_a/url" },
      headers: {
        browserbaseApiKey: { secretRef: "mcp/mcp_a/headers/browserbaseApiKey" },
        Accept: "application/json",
      },
    })

    const stdio = await externalizeMcpSecrets(
      base({
        command: "npx",
        args: ["-y", "@browserbasehq/mcp", "--modelApiKey", "sk-a", "--model-api-key=sk-b"],
        env: { modelApiKey: "sk-c", MODEL_NAME: "gpt-4o" },
      }),
      store
    )
    expect(stdio.migrated).toBe(3)
    expect(stdio.server.config).toEqual({
      command: "npx",
      args: [
        "-y",
        "@browserbasehq/mcp",
        "--modelApiKey",
        { secretRef: "mcp/mcp_a/args/3" },
        { secretRef: "mcp/mcp_a/args/4" },
      ],
      env: { modelApiKey: { secretRef: "mcp/mcp_a/env/modelApiKey" }, MODEL_NAME: "gpt-4o" },
    })
  })

  it("keeps non-secret neighbours of key-like names in place", async () => {
    const result = await externalizeMcpSecrets(
      base({
        command: "tool",
        args: ["--apikeys-file", "keys.txt", "--keyboard", "us"],
        env: { API_KEY_ID_HINT: "x", KEYBOARD: "us" },
      }),
      memoryStore()
    )
    // `API_KEY_ID_HINT` still carries the bounded `API_KEY` segment and stays
    // vaulted, exactly as before this pattern was widened.
    expect(result.server.config).toEqual({
      command: "tool",
      args: ["--apikeys-file", "keys.txt", "--keyboard", "us"],
      env: { API_KEY_ID_HINT: { secretRef: "mcp/mcp_a/env/API_KEY_ID_HINT" }, KEYBOARD: "us" },
    })
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
