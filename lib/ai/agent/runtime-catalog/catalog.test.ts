import { deriveBuiltinAdapter, listAgentRuntimes } from "./catalog"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

function agent(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    id: "a1",
    name: "Codex",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    process: { command: "codex", args: [] },
    ...overrides,
  } as ExternalAgentConfig
}

function hostRecord(overrides: Partial<ExternalAgentConfigRecord> = {}): ExternalAgentConfigRecord {
  return {
    configId: "eac_1",
    revision: "rev_1",
    lifecycleGeneration: 2,
    seq: 1,
    config: { name: "Pi on the box", protocol: "pi-rpc" },
    enabled: true,
    lifecycleStatus: "ready",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as ExternalAgentConfigRecord
}

const base = { externalEnabled: false, externalAgents: [], runtimeSupportsExternalAgents: true }

describe("deriveBuiltinAdapter", () => {
  it("answers the Anthropic SDK for anthropic and for an unset provider", () => {
    expect(deriveBuiltinAdapter("anthropic")).toBe("claude-agent-sdk")
    expect(deriveBuiltinAdapter(undefined)).toBe("claude-agent-sdk")
  })

  it("answers the AI SDK for every other provider", () => {
    expect(deriveBuiltinAdapter("deepseek")).toBe("ai-sdk")
    expect(deriveBuiltinAdapter("openai")).toBe("ai-sdk")
  })
})

describe("listAgentRuntimes", () => {
  it("always offers the builtin lane first", () => {
    const rows = listAgentRuntimes(base)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: "builtin", group: "builtin", nameKey: "cogniaAgent" })
  })

  it("names the engine that will really run the turn", () => {
    expect(listAgentRuntimes({ ...base, providerId: "anthropic" })[0]).toMatchObject({
      descriptionKey: "engineClaudeAgentSdk",
      derivedAdapter: "claude-agent-sdk",
    })
    // The regression this catalog exists for: the row used to claim the
    // Anthropic SDK sidecar on every provider.
    expect(listAgentRuntimes({ ...base, providerId: "deepseek" })[0]).toMatchObject({
      descriptionKey: "engineAiSdk",
      descriptionValues: { provider: "deepseek" },
      derivedAdapter: "ai-sdk",
    })
  })

  it("contributes no external rows while the master switch is off", () => {
    const rows = listAgentRuntimes({ ...base, externalAgents: [agent()] })
    expect(rows.map((row) => row.key)).toEqual(["builtin"])
  })

  it("sorts external rows by name and carries the protocol badge", () => {
    const rows = listAgentRuntimes({
      ...base,
      externalEnabled: true,
      externalAgents: [agent({ id: "a2", name: "Zed" }), agent({ id: "a1", name: "Codex" })],
    })
    expect(rows.map((row) => row.key)).toEqual(["builtin", "external:a1", "external:a2"])
    expect(rows[1].protocolLabel).toBe("ACP")
  })

  it("blocks a disabled agent and suppresses its warning", () => {
    const describeWarning = jest.fn(() => "stale")
    const rows = listAgentRuntimes({
      ...base,
      externalEnabled: true,
      externalAgents: [agent({ enabled: false })],
      describeWarning,
    })
    expect(rows[1].blockedReason).toBeTruthy()
    expect(rows[1].warning).toBeUndefined()
    expect(describeWarning).not.toHaveBeenCalled()
  })

  it("carries a warning for a runnable agent", () => {
    const rows = listAgentRuntimes({
      ...base,
      externalEnabled: true,
      externalAgents: [agent()],
      describeWarning: () => "needs sign-in",
    })
    expect(rows[1].blockedReason).toBeUndefined()
    expect(rows[1].warning).toBe("needs sign-in")
  })

  it("carries the plane's reason and its transient marker onto the row", () => {
    // A Host still reporting its features becomes a Host that can spawn
    // moments later, and the selector reads `blockTransient` to decide whether
    // a block is settled enough to rewrite the user's chosen runtime. Handing
    // the catalog a bare `false` threw both away, so a companion lost its
    // agent selection on every launch and was told to install the desktop app.
    const rows = listAgentRuntimes({
      ...base,
      externalEnabled: true,
      externalAgents: [agent()],
      runtimeSupportsExternalAgents: { ok: false, reason: "manifest-missing" },
    })
    expect(rows[1].blockedReason).toMatch(/has not finished/i)
    expect(rows[1].blockTransient).toBe(true)

    // Every reach failure is environment scoped, so the marker rides all of
    // them: the row still refuses, but the selection behind it is not rewritten.
    const notGranted = listAgentRuntimes({
      ...base,
      externalEnabled: true,
      externalAgents: [agent()],
      runtimeSupportsExternalAgents: { ok: false, reason: "not-granted" },
    })
    expect(notGranted[1].blockedReason).toMatch(/agent control/i)
    expect(notGranted[1].blockTransient).toBe(true)
  })

  it("runs an agent through a paired host that can start the process", () => {
    const rows = listAgentRuntimes({
      ...base,
      externalEnabled: true,
      externalAgents: [agent()],
      runtimeSupportsExternalAgents: { ok: true, via: "remote" },
    })
    expect(rows[1].blockedReason).toBeUndefined()
  })

  it("keeps host rows in their own group and only when ready and enabled", () => {
    const rows = listAgentRuntimes({
      ...base,
      hostConfigs: [
        hostRecord(),
        hostRecord({ configId: "eac_2", enabled: false }),
        hostRecord({ configId: "eac_3", lifecycleStatus: "draft" as never }),
      ],
    })
    expect(rows.map((row) => row.key)).toEqual(["builtin", "host:eac_1"])
    expect(rows[1]).toMatchObject({
      group: "host",
      name: "Pi on the box",
      protocolLabel: "PI-RPC",
      ref: { kind: "host", configId: "eac_1", revision: "rev_1", lifecycleGeneration: 2 },
    })
  })
})
