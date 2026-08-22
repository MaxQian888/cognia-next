import type { KeyringStore } from "@/lib/credentials/keyring-store"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import {
  EXTERNAL_AGENT_CREDENTIAL_REQUIRED_MARKER,
  ExternalAgentLifecycleError,
} from "@/types/agent/external-agent-lifecycle"

import {
  applyResolvedCredentials,
  clearCredentials,
  credentialKeyId,
  credentialsRequiredByImport,
  extractInlineCredentials,
  migrateInlineCredentials,
  occupiedSlots,
  persistCredentials,
  redactConfigForLogging,
  resolveCredentials,
  sanitizeConfigForExport,
  scrubInlineCredentials,
  type LifecycleAgentConfig,
} from "./credentials"

const SECRET = "sk-live-do-not-log-me"

function memoryStore(): KeyringStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>()
  return {
    entries,
    save: async (keyId, value) => {
      entries.set(keyId, value)
    },
    load: async (keyId) => entries.get(keyId) ?? null,
    delete: async (keyId) => {
      entries.delete(keyId)
    },
  }
}

function config(overrides: Partial<LifecycleAgentConfig> = {}): LifecycleAgentConfig {
  return {
    id: "agent-1",
    name: "Example",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    ...overrides,
  }
}

function networked(): LifecycleAgentConfig {
  return config({
    transport: "http",
    network: {
      endpoint: "https://agent.test",
      apiKey: SECRET,
      bearerToken: "bearer-token-value",
      headers: { Authorization: "Bearer xyz", "X-Trace-Id": "trace-42" },
      proxy: { host: "proxy.test", port: 8080, auth: { username: "u", password: "p" } },
    },
    process: {
      command: "agent",
      env: { OPENAI_API_KEY: "env-secret", AGENT_LOG_LEVEL: "debug" },
    },
  })
}

describe("extractInlineCredentials", () => {
  it("pulls every secret-bearing field", () => {
    const secrets = extractInlineCredentials(networked())
    expect(secrets.apiKey).toBe(SECRET)
    expect(secrets.bearerToken).toBe("bearer-token-value")
    expect(secrets.headers).toEqual({ Authorization: "Bearer xyz" })
    expect(secrets.proxyAuth).toEqual({ username: "u", password: "p" })
    expect(secrets.processEnv).toEqual({ OPENAI_API_KEY: "env-secret" })
  })

  it("splits header and env maps by name, keeping non-secrets out of the keyring", () => {
    const secrets = extractInlineCredentials(networked())
    expect(secrets.headers).not.toHaveProperty("X-Trace-Id")
    expect(secrets.processEnv).not.toHaveProperty("AGENT_LOG_LEVEL")
  })

  it("reports nothing for a config with no secrets", () => {
    const secrets = extractInlineCredentials(config({ process: { command: "codex" } }))
    expect(occupiedSlots(secrets)).toEqual([])
  })
})

describe("scrubInlineCredentials", () => {
  it("removes secret values but keeps the structure that identifies the agent", () => {
    const scrubbed = scrubInlineCredentials(networked())
    expect(scrubbed.network?.endpoint).toBe("https://agent.test")
    expect(scrubbed.network?.apiKey).toBeUndefined()
    expect(scrubbed.network?.bearerToken).toBeUndefined()
    expect(scrubbed.network?.headers).toEqual({ "X-Trace-Id": "trace-42" })
    expect(scrubbed.network?.proxy).toEqual({ host: "proxy.test", port: 8080 })
    expect(scrubbed.process?.env).toEqual({ AGENT_LOG_LEVEL: "debug" })
    expect(scrubbed.process?.command).toBe("agent")
  })

  it("does not mutate the input", () => {
    const original = networked()
    scrubInlineCredentials(original)
    expect(original.network?.apiKey).toBe(SECRET)
  })

  it("leaves a secret-free config alone", () => {
    const plain = config({ process: { command: "codex", env: { AGENT_LOG_LEVEL: "debug" } } })
    expect(scrubInlineCredentials(plain).process?.env).toEqual({ AGENT_LOG_LEVEL: "debug" })
  })
})

describe("sanitizeConfigForExport", () => {
  it("exports no secret and marks what the importer must supply", () => {
    const { config: exported, credentialsRequired } = sanitizeConfigForExport(networked())
    expect(JSON.stringify(exported)).not.toContain(SECRET)
    expect(JSON.stringify(exported)).not.toContain("bearer-token-value")
    expect(JSON.stringify(exported)).not.toContain("env-secret")
    expect(credentialsRequired).toEqual([
      "apiKey",
      "bearerToken",
      "headers",
      "processEnv",
      "proxyAuth",
    ])
    expect(exported.metadata?.[EXTERNAL_AGENT_CREDENTIAL_REQUIRED_MARKER]).toEqual(
      credentialsRequired
    )
  })

  it("drops keyring references, which name entries the importing host lacks", () => {
    const source = config({ credentialRefs: { apiKey: "agent-1:apiKey" } })
    const { config: exported, credentialsRequired } = sanitizeConfigForExport(source)
    expect(exported.credentialRefs).toBeUndefined()
    // The slot is still declared required, so the import asks rather than
    // producing an agent that looks credentialled and is not.
    expect(credentialsRequired).toEqual(["apiKey"])
  })

  it("adds no marker when nothing is required", () => {
    const { config: exported, credentialsRequired } = sanitizeConfigForExport(config())
    expect(credentialsRequired).toEqual([])
    expect(exported.metadata?.[EXTERNAL_AGENT_CREDENTIAL_REQUIRED_MARKER]).toBeUndefined()
  })

  it("round-trips the marker back through credentialsRequiredByImport", () => {
    const { config: exported } = sanitizeConfigForExport(networked())
    expect(credentialsRequiredByImport(exported)).toEqual([
      "apiKey",
      "bearerToken",
      "headers",
      "processEnv",
      "proxyAuth",
    ])
  })

  it("ignores a malformed or hostile marker", () => {
    expect(
      credentialsRequiredByImport(
        config({ metadata: { [EXTERNAL_AGENT_CREDENTIAL_REQUIRED_MARKER]: "apiKey" } })
      )
    ).toEqual([])
    expect(
      credentialsRequiredByImport(
        config({ metadata: { [EXTERNAL_AGENT_CREDENTIAL_REQUIRED_MARKER]: ["apiKey", "rm -rf"] } })
      )
    ).toEqual(["apiKey"])
  })
})

describe("redactConfigForLogging", () => {
  it("names the populated slots without exposing any value", () => {
    const { config: safe, populatedSlots } = redactConfigForLogging(networked())
    expect(JSON.stringify(safe)).not.toContain(SECRET)
    expect(populatedSlots).toContain("apiKey")
    expect(populatedSlots).toContain("processEnv")
  })

  it("counts slots that live only as keyring references", () => {
    const { populatedSlots } = redactConfigForLogging(
      config({ credentialRefs: { bearerToken: "agent-1:bearerToken" } })
    )
    expect(populatedSlots).toEqual(["bearerToken"])
  })
})

describe("keyring persistence", () => {
  it("writes each occupied slot under a deterministic key", async () => {
    const store = memoryStore()
    const refs = await persistCredentials("agent-1", extractInlineCredentials(networked()), store)

    expect(refs.apiKey).toBe(credentialKeyId("agent-1", "apiKey"))
    expect(store.entries.get("agent-1:apiKey")).toBe(SECRET)
    expect(JSON.parse(store.entries.get("agent-1:headers")!)).toEqual({
      Authorization: "Bearer xyz",
    })
  })

  it("deletes a slot the caller no longer supplies instead of orphaning it", async () => {
    const store = memoryStore()
    await persistCredentials("agent-1", { apiKey: SECRET, bearerToken: "b" }, store)
    expect(store.entries.has("agent-1:bearerToken")).toBe(true)

    const refs = await persistCredentials("agent-1", { apiKey: SECRET }, store)
    expect(store.entries.has("agent-1:bearerToken")).toBe(false)
    expect(refs.bearerToken).toBeUndefined()
  })

  it("clears every slot for one agent", async () => {
    const store = memoryStore()
    await persistCredentials("agent-1", extractInlineCredentials(networked()), store)
    await persistCredentials("agent-2", { apiKey: "other" }, store)

    await clearCredentials("agent-1", store)

    expect([...store.entries.keys()]).toEqual(["agent-2:apiKey"])
  })
})

describe("resolveCredentials", () => {
  it("returns nothing when the agent has no references", async () => {
    expect(await resolveCredentials(undefined, memoryStore())).toEqual({})
  })

  it("resolves strings and maps back to their original shapes", async () => {
    const store = memoryStore()
    const refs = await persistCredentials("agent-1", extractInlineCredentials(networked()), store)

    const resolved = await resolveCredentials(refs, store)
    expect(resolved.apiKey).toBe(SECRET)
    expect(resolved.headers).toEqual({ Authorization: "Bearer xyz" })
    expect(resolved.proxyAuth).toEqual({ username: "u", password: "p" })
  })

  it("fails loudly, naming the slot and never the value, when the keyring lost an entry", async () => {
    const store = memoryStore()
    const refs = await persistCredentials("agent-1", { apiKey: SECRET }, store)
    store.entries.clear()

    await expect(resolveCredentials(refs, store)).rejects.toBeInstanceOf(
      ExternalAgentLifecycleError
    )
    await expect(resolveCredentials(refs, store)).rejects.toMatchObject({
      code: "credential_missing",
      details: { slot: "apiKey" },
    })
    await expect(resolveCredentials(refs, store)).rejects.not.toMatchObject({
      message: expect.stringContaining(SECRET),
    })
  })
})

describe("applyResolvedCredentials", () => {
  it("rebuilds a launch-ready config without touching the stored one", () => {
    const stored = scrubInlineCredentials(networked())
    const launch = applyResolvedCredentials(stored, {
      apiKey: SECRET,
      headers: { Authorization: "Bearer xyz" },
      proxyAuth: { username: "u", password: "p" },
      processEnv: { OPENAI_API_KEY: "env-secret" },
    })

    expect(launch.network?.apiKey).toBe(SECRET)
    expect(launch.network?.headers).toEqual({
      "X-Trace-Id": "trace-42",
      Authorization: "Bearer xyz",
    })
    expect(launch.network?.proxy?.auth).toEqual({ username: "u", password: "p" })
    expect(launch.process?.env).toEqual({ AGENT_LOG_LEVEL: "debug", OPENAI_API_KEY: "env-secret" })

    // The persisted copy stays clean.
    expect(stored.network?.apiKey).toBeUndefined()
    expect(stored.process?.env).toEqual({ AGENT_LOG_LEVEL: "debug" })
  })

  it("adds process env even when the config had no process block", () => {
    const launch = applyResolvedCredentials(config() as ExternalAgentConfig, {
      processEnv: { TOKEN: "t" },
    })
    expect(launch.process?.env).toEqual({ TOKEN: "t" })
  })

  it("does not invent a proxy just because proxy credentials resolved", () => {
    const launch = applyResolvedCredentials(
      config({ transport: "http", network: { endpoint: "https://a.test" } }),
      { proxyAuth: { username: "u", password: "p" } }
    )
    expect(launch.network?.proxy).toBeUndefined()
  })
})

describe("migrateInlineCredentials", () => {
  it("leaves a config with no inline secrets untouched", async () => {
    const source = config()
    const result = await migrateInlineCredentials(source, memoryStore())
    expect(result.config).toBe(source)
    expect(result.migrated).toEqual([])
  })

  it("moves every secret to the keyring and scrubs the persisted copy", async () => {
    const store = memoryStore()
    const result = await migrateInlineCredentials(networked(), store)

    expect(result.failure).toBeUndefined()
    expect(result.migrated).toEqual(["apiKey", "bearerToken", "headers", "proxyAuth", "processEnv"])
    expect(JSON.stringify(result.config)).not.toContain(SECRET)
    expect(result.config.credentialRefs?.apiKey).toBe("agent-1:apiKey")
    expect(store.entries.get("agent-1:apiKey")).toBe(SECRET)
    expect(result.config.enabled).toBe(true)
  })

  it("scrubs the plaintext and disables the agent when the keyring write fails", async () => {
    const store = memoryStore()
    store.save = async () => {
      throw new Error("keyring locked")
    }

    const result = await migrateInlineCredentials(networked(), store)

    // The whole point: a failed migration must not leave the secret behind.
    expect(JSON.stringify(result.config)).not.toContain(SECRET)
    expect(result.config.enabled).toBe(false)
    expect(result.config.lifecycleStatus).toBe("needs-credentials")
    expect(result.config.lifecycleReasonCode).toBe("credential_missing")
    expect(result.migrated).toEqual([])
    expect(result.failure?.reason).toBe("keyring locked")
    expect(result.failure?.slots).toContain("apiKey")
  })

  it("does not log the secret in the failure reason", async () => {
    const store = memoryStore()
    store.save = async () => {
      throw new Error(`refused to store ${"redacted"}`)
    }
    const result = await migrateInlineCredentials(networked(), store)
    expect(result.failure?.reason).not.toContain(SECRET)
  })
})
