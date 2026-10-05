/** @jest-environment jsdom */
import {
  createExternalAgentsAPI,
  EXTERNAL_AGENT_REDACTED,
  PluginExternalAgentInputError,
  redactEndpoint,
  redactSecretArgs,
  type PluginExternalAgentsAPI,
} from "./external-agents-api"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { adaptPermissionMode } from "@/lib/ai/agent/external/policy/permission-modes"
import type { CreateExternalAgentInput } from "@/types/agent/external-agent"
import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"

const mockService = {
  createConfig: jest.fn(),
  updateConfig: jest.fn(),
  duplicateConfig: jest.fn(),
  removeConfig: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
  assessReadiness: jest.fn(),
}
jest.mock("@/lib/ai/agent/external/lifecycle/service", () => ({
  getExternalAgentLifecycleService: async () => mockService,
}))

const mockDetectInstalledRuntimes = jest.fn()
jest.mock("@/lib/ai/agent/external/config/installed-runtimes", () => {
  class ExternalAgentDetectionUnavailableError extends Error {}
  return {
    detectInstalledRuntimes: (...args: unknown[]) => mockDetectInstalledRuntimes(...args),
    ExternalAgentDetectionUnavailableError,
  }
})

jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: async () => (key: string, values?: Record<string, unknown>) =>
    key === "duplicateName"
      ? `${values?.name} (copy)`
      : `${values?.name} (copy ${String(values?.index)})`,
}))

const PLUGIN = "ext-agents-plugin"
const READ = "agent:external:read"
const MANAGE = "agent:external:manage"

const state = () => useExternalAgentStore.getState()

function seed(input: Partial<CreateExternalAgentInput> = {}): string {
  return state().addAgent({
    name: "Claude",
    protocol: "acp",
    transport: "stdio",
    process: { command: "claude-code-acp", args: [] },
    ...input,
  })
}

function apiWith(permissions: string[]): PluginExternalAgentsAPI {
  getPermissionGuard().registerPlugin(PLUGIN, permissions as never)
  return createExternalAgentsAPI(PLUGIN)
}

async function refusal(promise: Promise<unknown>): Promise<PluginExternalAgentInputError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(PluginExternalAgentInputError)
  return error as PluginExternalAgentInputError
}

beforeEach(() => {
  jest.clearAllMocks()
  resetPermissionGuard()
  state().reset()
  state().setEnabled(true)
  mockService.createConfig.mockImplementation(async (input: CreateExternalAgentInput) =>
    state().addAgent(input)
  )
  mockService.updateConfig.mockImplementation(async (id: string, patch: object) =>
    state().updateAgent(id, patch)
  )
  mockService.duplicateConfig.mockImplementation(
    async (id: string, options: { name: string; stateIsolation?: string }) => {
      const source = state().getAgent(id)!
      return state().addAgent({
        name: options.name,
        protocol: source.protocol,
        transport: source.transport,
        process: source.process,
        stateIsolation: (options.stateIsolation as "isolated") ?? "isolated",
        duplicatedFromAgentId: id,
        metadata: { ...source.metadata },
      })
    }
  )
  mockService.removeConfig.mockImplementation(async (id: string) => state().removeAgent(id))
  mockService.connect.mockImplementation(async (id: string) =>
    state().setConnectionStatus(id, "connected")
  )
  mockService.disconnect.mockImplementation(async (id: string) =>
    state().setConnectionStatus(id, "disconnected")
  )
  mockService.assessReadiness.mockResolvedValue({ status: "ready" })
})

describe("permission gating (fail-closed)", () => {
  it("refuses every read without agent:external:read", () => {
    const api = apiWith([])
    expect(() => api.list()).toThrow(PermissionError)
    expect(() => api.get("x")).toThrow(PermissionError)
    expect(() => api.getReadiness("x")).toThrow(PermissionError)
    expect(() => api.listPresets()).toThrow(PermissionError)
    expect(() => api.listRuntimes()).toThrow(PermissionError)
    expect(() => api.getSettings()).toThrow(PermissionError)
    expect(() => api.listDelegationRules()).toThrow(PermissionError)
    expect(() => api.onChange(() => {})).toThrow(PermissionError)
  })

  it("refuses every write with read alone", () => {
    const api = apiWith([READ])
    const id = seed()
    expect(() => api.create({ name: "x", protocol: "acp" })).toThrow(PermissionError)
    expect(() => api.createFromPreset("claude-code")).toThrow(PermissionError)
    expect(() => api.update(id, { name: "y" })).toThrow(PermissionError)
    expect(() => api.duplicate(id)).toThrow(PermissionError)
    expect(() => api.remove(id)).toThrow(PermissionError)
    expect(() => api.setEnabled(id, false)).toThrow(PermissionError)
    expect(() => api.connect(id)).toThrow(PermissionError)
    expect(() => api.disconnect(id)).toThrow(PermissionError)
    expect(() =>
      api.addDelegationRule({
        name: "r",
        condition: "always",
        matcher: "",
        targetAgentId: id,
        priority: 1,
        enabled: true,
      })
    ).toThrow(PermissionError)
    expect(() => api.updateDelegationRule("r", {})).toThrow(PermissionError)
    expect(() => api.removeDelegationRule("r")).toThrow(PermissionError)
    expect(() => api.reorderDelegationRules([])).toThrow(PermissionError)
    expect(() => api.updateSettings({ enabled: false })).toThrow(PermissionError)
    expect(mockService.removeConfig).not.toHaveBeenCalled()
  })

  it("does not let manage stand in for read", () => {
    const api = apiWith([MANAGE])
    expect(() => api.list()).toThrow(PermissionError)
  })
})

describe("projection never carries a secret", () => {
  const SECRETS = [
    "sk-live-api-key-0123456789abcdef",
    "bearer-0123456789abcdef",
    "header-secret-value",
    "env-secret-value",
    "proxy-password",
    "server-password-value",
    "arg-secret-value",
    "assignment-secret-value",
    "url-password",
    "query-token-value",
  ]

  it("scrubs inline secrets, env, headers, proxy, metadata, URL and argument credentials", async () => {
    const id = seed({
      name: "Leaky",
      description: "legacy config",
      transport: "http",
      process: {
        command: "agent",
        args: ["--api-key", SECRETS[6], "--model", "opus", `--token=${SECRETS[7]}`, "-v"],
        cwd: "/work",
        env: { OPENAI_API_KEY: SECRETS[3], PLAIN_FLAG: "1" },
      },
      network: {
        endpoint: `https://user:${SECRETS[8]}@agents.example.com/rpc?token=${SECRETS[9]}&mode=fast`,
        apiKey: SECRETS[0],
        bearerToken: SECRETS[1],
        headers: { Authorization: SECRETS[2], "X-Trace": "on" },
        proxy: { host: "proxy", port: 8080, auth: { username: "u", password: SECRETS[4] } },
      },
      metadata: { preset: "claude-code", serverPassword: SECRETS[5], createdByPluginId: "other" },
      tags: ["work"],
    })
    state().patchLifecycle(id, {
      credentialRefs: { bearerToken: `${id}:bearerToken` },
      lifecycleStatus: "needs-credentials",
      lifecycleReasonCode: "credential_missing",
    })

    const [projected] = await apiWith([READ]).list()
    const wire = JSON.stringify(projected)
    for (const secret of SECRETS) expect(wire).not.toContain(secret)
    expect(wire).not.toContain("OPENAI_API_KEY")
    expect(wire).not.toContain("PLAIN_FLAG")
    expect(wire).not.toContain("X-Trace")
    expect(wire).not.toContain("8080")
    expect(projected).not.toHaveProperty("metadata")
    expect(wire).not.toContain(`${id}:bearerToken`)

    expect(projected).toMatchObject({
      id,
      name: "Leaky",
      description: "legacy config",
      protocol: "acp",
      transport: "http",
      presetId: "claude-code",
      createdByPluginId: "other",
      stateIsolation: "isolated",
      process: {
        command: "agent",
        args: [
          "--api-key",
          EXTERNAL_AGENT_REDACTED,
          "--model",
          "opus",
          `--token=${EXTERNAL_AGENT_REDACTED}`,
          "-v",
        ],
        cwd: "/work",
      },
      tags: ["work"],
      connectionStatus: "disconnected",
      lifecycleStatus: "needs-credentials",
      lifecycleReasonCode: "credential_missing",
    })
    expect(projected.network?.endpoint).toContain("agents.example.com/rpc")
    expect(projected.network?.endpoint).toContain("mode=fast")
    expect(projected.credentialSlots).toEqual(
      expect.arrayContaining([
        "apiKey",
        "bearerToken",
        "headers",
        "processEnv",
        "proxyAuth",
        "serverPassword",
      ])
    )
    expect(Object.keys(projected.readiness).sort()).toEqual(["blockReason", "nextAction", "state"])
    expect(projected.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("reads a config persisted before stateIsolation existed as shared", async () => {
    const id = seed()
    const stored = state().agents[id]
    useExternalAgentStore.setState({
      agents: { [id]: { ...stored, stateIsolation: undefined } },
    })
    expect((await apiWith([READ]).get(id))?.stateIsolation).toBe("shared")
  })

  it("returns null for an unknown id", async () => {
    expect(await apiWith([READ]).get("nope")).toBeNull()
  })

  it("redacts only credential-looking argument values and URL parts", () => {
    expect(redactSecretArgs(["--auth-token", "--verbose", "OPENAI_API_KEY=x", "plain"])).toEqual([
      "--auth-token",
      "--verbose",
      `OPENAI_API_KEY=${EXTERNAL_AGENT_REDACTED}`,
      "plain",
    ])
    expect(redactEndpoint("http://localhost:4096")).toBe("http://localhost:4096")
    expect(redactEndpoint("not a url")).toBe("not a url")
    expect(redactEndpoint("https://a:b@h/p?api_key=1")).not.toContain("a:b")
  })
})

describe("readiness, presets, runtimes, settings", () => {
  it("adds the lifecycle verdict to the row readiness", async () => {
    const id = seed()
    mockService.assessReadiness.mockResolvedValue({
      status: "needs-credentials",
      reasonCode: "credential_missing",
      reason: 'no keyring entry for credential slot "apiKey"',
    })
    const readiness = await apiWith([READ]).getReadiness(id)
    expect(readiness.agentId).toBe(id)
    expect(readiness.verdict).toEqual({
      status: "needs-credentials",
      reasonCode: "credential_missing",
      reason: 'no keyring entry for credential slot "apiKey"',
    })
    expect(readiness.steps.map((step) => step.id)).toEqual([
      "configured",
      "runnable",
      "connected",
      "routed",
    ])
    expect(mockService.assessReadiness).toHaveBeenCalledWith(expect.objectContaining({ id }))
    const error = await refusal(apiWith([READ]).getReadiness("nope"))
    expect(error.code).toBe("unknown_agent")
  })

  it("lists presets with a runnable flag and no process env", async () => {
    const presets = await apiWith([READ]).listPresets()
    const claude = presets.find((preset) => preset.id === "claude-code")
    expect(claude).toMatchObject({ runnable: true, protocol: "acp", contributedByPluginId: null })
    expect(presets.find((preset) => preset.id === "opencode-server")?.runnable).toBe(false)
    // A preset's process env (Goose's `GOOSE_MODE=approve`) is never projected.
    expect(JSON.stringify(presets)).not.toContain('"approve"')
    for (const preset of presets) expect(preset).not.toHaveProperty("process")
  })

  it("reports runtimes, and says when nothing can be asked", async () => {
    mockDetectInstalledRuntimes.mockResolvedValueOnce([
      {
        runtimeId: "codex",
        command: "codex",
        resolution: "installed",
        executablePath: "/usr/bin/codex",
        version: "0.150.0",
        detail: "host note",
      },
    ])
    const api = apiWith([READ])
    expect(await api.listRuntimes({ refresh: true })).toEqual({
      available: true,
      runtimes: [
        {
          runtimeId: "codex",
          command: "codex",
          resolution: "installed",
          executablePath: "/usr/bin/codex",
          version: "0.150.0",
        },
      ],
    })
    expect(mockDetectInstalledRuntimes).toHaveBeenCalledWith({ refresh: true })
    const { ExternalAgentDetectionUnavailableError } = jest.requireMock(
      "@/lib/ai/agent/external/config/installed-runtimes"
    ) as { ExternalAgentDetectionUnavailableError: new () => Error }
    mockDetectInstalledRuntimes.mockRejectedValueOnce(new ExternalAgentDetectionUnavailableError())
    expect(await api.listRuntimes()).toEqual({ available: false, runtimes: [] })
  })

  it("reads and validates global settings without half-applying a patch", async () => {
    const api = apiWith([READ, MANAGE])
    expect(await api.getSettings()).toEqual({
      enabled: true,
      defaultPermissionMode: state().defaultPermissionMode,
      autoConnectOnStartup: false,
      showConnectionNotifications: true,
      chatFailurePolicy: "fallback",
    })
    await refusal(api.updateSettings({ enabled: false, chatFailurePolicy: "sometimes" as never }))
    expect(state().enabled).toBe(true)
    await refusal(api.updateSettings({ defaultPermissionMode: "dontAsk" as never }))
    await refusal(api.updateSettings({ unknown: true } as never))
    expect(
      await api.updateSettings({
        enabled: false,
        defaultPermissionMode: "plan",
        autoConnectOnStartup: true,
        showConnectionNotifications: false,
        chatFailurePolicy: "strict",
      })
    ).toEqual({
      enabled: false,
      defaultPermissionMode: "plan",
      autoConnectOnStartup: true,
      showConnectionNotifications: false,
      chatFailurePolicy: "strict",
    })
  })
})

describe("create", () => {
  const api = () => apiWith([READ, MANAGE])

  it.each([
    [{ network: { endpoint: "https://a.example", apiKey: "k" } }, "network.apiKey"],
    [{ network: { endpoint: "https://a.example", bearerToken: "" } }, "network.bearerToken"],
    [
      { network: { endpoint: "https://a.example", headers: { Authorization: "Bearer x" } } },
      "network.headers",
    ],
    [{ process: { command: "x", env: { OPENAI_API_KEY: "sk" } } }, "process.env"],
    [{ process: { command: "x", args: ["--api-key", "sk-123"] } }, "process.args"],
    [{ metadata: { serverPassword: "pw" } }, "metadata.serverPassword"],
    [{ network: { endpoint: "https://u:p@a.example" } }, "network.endpoint"],
  ])("refuses an inline credential (%j)", async (extra, field) => {
    const error = await refusal(
      api().create({ name: "X", protocol: "acp", ...(extra as object) } as never)
    )
    expect(error.code).toBe("inline_credentials")
    expect(error.message).toContain(field)
    expect(error.message).toContain("Settings")
    expect(mockService.createConfig).not.toHaveBeenCalled()
  })

  it("creates through the lifecycle service, stamped and isolated by default", async () => {
    const created = await api().create({
      name: "Read-only Codex",
      protocol: "codex-app-server",
      process: { command: "codex", args: ["app-server"], cwd: "/repo", env: { RUST_LOG: "info" } },
      defaultPermissionMode: "dontAsk",
      maxConcurrentSessions: 2,
      sessionIdleTimeout: 60_000,
      subscriptionAccountId: "acct-2",
      tags: ["ro"],
      codexOptions: { sandboxMode: "readOnly" },
    })
    const input = mockService.createConfig.mock.calls[0][0] as CreateExternalAgentInput
    expect(input.metadata).toMatchObject({ createdByPluginId: PLUGIN })
    expect(input.stateIsolation).toBe("isolated")
    expect(input.defaultPermissionMode).toBe(
      adaptPermissionMode("dontAsk", "codex-app-server").mode
    )
    expect(input.process).toMatchObject({
      command: "codex",
      args: ["app-server"],
      cwd: "/repo",
      env: { RUST_LOG: "info" },
    })
    expect(created).toMatchObject({
      name: "Read-only Codex",
      createdByPluginId: PLUGIN,
      stateIsolation: "isolated",
      maxConcurrentSessions: 2,
      sessionIdleTimeout: 60_000,
      subscriptionAccountId: "acct-2",
    })
  })

  it("refuses unknown fields, unsupported protocols and incomplete configs", async () => {
    expect(
      (
        await refusal(
          api().create({ name: "X", protocol: "acp", autoApprovePatterns: [] } as never)
        )
      ).code
    ).toBe("invalid_input")
    expect(
      (await refusal(api().create({ name: "X", protocol: "nonsense" as never }))).message
    ).toContain("unsupportedProtocol")
    expect((await refusal(api().create({ name: "X", protocol: "acp" }))).message).toContain(
      "commandRequired"
    )
    expect(
      (
        await refusal(
          api().create({
            name: "X",
            protocol: "acp",
            process: { command: "x" },
            maxConcurrentSessions: 0,
          })
        )
      ).code
    ).toBe("invalid_input")
    expect(mockService.createConfig).not.toHaveBeenCalled()
  })
})

describe("createFromPreset", () => {
  const api = () => apiWith([READ, MANAGE])

  it("builds the preset through the add-agent form rules", async () => {
    const created = await api().createFromPreset("claude-code", {
      name: "Work Claude",
      stateIsolation: "shared",
      process: { cwd: "/repo" },
    })
    const input = mockService.createConfig.mock.calls[0][0] as CreateExternalAgentInput
    expect(input.metadata).toMatchObject({ preset: "claude-code", createdByPluginId: PLUGIN })
    expect(input.stateIsolation).toBe("shared")
    expect(input.process?.cwd).toBe("/repo")
    expect(created).toMatchObject({ name: "Work Claude", presetId: "claude-code" })
  })

  it("refuses unknown, documented-only and credential-carrying requests", async () => {
    expect((await refusal(api().createFromPreset("nope"))).code).toBe("unknown_preset")
    expect((await refusal(api().createFromPreset("custom"))).code).toBe("unknown_preset")
    expect((await refusal(api().createFromPreset("opencode-server"))).code).toBe("unknown_preset")
    expect(
      (
        await refusal(
          api().createFromPreset("claude-code", {
            process: { env: { ANTHROPIC_API_KEY: "sk" } },
          })
        )
      ).code
    ).toBe("inline_credentials")
    expect(
      (
        await refusal(
          api().createFromPreset("deepseek-harness-workspace", { process: { command: "x" } })
        )
      ).code
    ).toBe("invalid_input")
    expect(mockService.createConfig).not.toHaveBeenCalled()
  })
})

describe("update / enable / connect / remove", () => {
  const api = () => apiWith([READ, MANAGE])

  it("passes an allowlisted patch, clamping the mode to the protocol", async () => {
    const id = seed({ protocol: "a2a", transport: "http", network: { endpoint: "https://a" } })
    const updated = await api().update(id, {
      name: "Renamed",
      defaultPermissionMode: "bypassPermissions",
      network: { endpoint: "https://b" },
      maxConcurrentSessions: 4,
      subscriptionAccountId: null,
      stateIsolation: "isolated",
    })
    expect(mockService.updateConfig).toHaveBeenCalledWith(id, {
      name: "Renamed",
      network: { endpoint: "https://b" },
      stateIsolation: "isolated",
      subscriptionAccountId: null,
      maxConcurrentSessions: 4,
      defaultPermissionMode: "default",
    })
    expect(updated.name).toBe("Renamed")
  })

  it("refuses env, network secrets and fields outside the edit surface", async () => {
    const id = seed()
    for (const patch of [
      { process: { env: { FOO: "bar" } } },
      { network: { endpoint: "https://a", apiKey: "k" } },
      { network: { endpoint: "https://a", headers: {} } },
      { process: { args: ["--token", "abc"] } },
    ]) {
      expect((await refusal(api().update(id, patch as never))).code).toBe("inline_credentials")
    }
    expect((await refusal(api().update(id, { metadata: {} } as never))).code).toBe("invalid_input")
    expect((await refusal(api().update(id, { process: { command: " " } }))).code).toBe(
      "invalid_input"
    )
    expect((await refusal(api().update("nope", { name: "x" }))).code).toBe("unknown_agent")
    expect(mockService.updateConfig).not.toHaveBeenCalled()
  })

  it("routes enable, connect, disconnect and remove through the lifecycle", async () => {
    const id = seed()
    expect((await api().setEnabled(id, false)).enabled).toBe(false)
    expect(mockService.updateConfig).toHaveBeenCalledWith(id, { enabled: false })
    expect((await api().connect(id)).connectionStatus).toBe("connected")
    expect((await api().disconnect(id)).connectionStatus).toBe("disconnected")
    state().setEnabled(false)
    expect((await refusal(api().connect(id))).code).toBe("external_agents_disabled")
    await api().remove(id)
    expect(mockService.removeConfig).toHaveBeenCalledWith(id)
    expect(state().getAgent(id)).toBeUndefined()
  })
})

describe("duplicate", () => {
  const api = () => apiWith([READ, MANAGE])

  it("picks the first free localized copy name and stamps the copy", async () => {
    const id = seed({ name: "Codex" })
    seed({ name: "Codex (copy)" })
    const copy = await api().duplicate(id)
    expect(mockService.duplicateConfig).toHaveBeenCalledWith(id, { name: "Codex (copy 2)" })
    expect(mockService.updateConfig).toHaveBeenCalledWith(copy.id, {
      metadata: { createdByPluginId: PLUGIN },
    })
    expect(copy).toMatchObject({
      name: "Codex (copy 2)",
      duplicatedFromAgentId: id,
      createdByPluginId: PLUGIN,
      stateIsolation: "isolated",
    })
  })

  it("passes the chosen name, isolation and enabled state through", async () => {
    const id = seed()
    await api().duplicate(id, { name: "Second", stateIsolation: "shared", enabled: false })
    expect(mockService.duplicateConfig).toHaveBeenCalledWith(id, {
      name: "Second",
      stateIsolation: "shared",
      enabled: false,
    })
    expect((await refusal(api().duplicate(id, { color: "red" } as never))).code).toBe(
      "invalid_input"
    )
  })

  it("ships both copy-name keys in both locales", () => {
    const en = (enMessages as { plugins: { externalAgents: Record<string, string> } }).plugins
      .externalAgents
    const zh = (zhMessages as { plugins: { externalAgents: Record<string, string> } }).plugins
      .externalAgents
    for (const messages of [en, zh]) {
      expect(messages.duplicateName).toContain("{name}")
      expect(messages.duplicateNameNumbered).toContain("{index}")
    }
  })
})

describe("delegation rules", () => {
  const api = () => apiWith([READ, MANAGE])

  it("adds, updates, reorders and removes validated rules", async () => {
    const target = seed()
    const first = await api().addDelegationRule({
      name: "Tests",
      condition: "keyword",
      matcher: "test|spec",
      targetAgentId: target,
      priority: 1,
      enabled: true,
    })
    const second = await api().addDelegationRule({
      name: "Always",
      condition: "always",
      matcher: "",
      targetAgentId: target,
      priority: 0,
      enabled: true,
    })
    expect((await api().updateDelegationRule(first.id, { enabled: false })).enabled).toBe(false)
    const reordered = await api().reorderDelegationRules([second.id, first.id])
    expect(reordered.map((rule) => rule.id)).toEqual([second.id, first.id])
    expect(await apiWith([READ]).listDelegationRules()).toHaveLength(2)
    await api().removeDelegationRule(first.id)
    expect(state().delegationRules.map((rule) => rule.id)).toEqual([second.id])
  })

  it("refuses unknown targets, broken regexes and partial reorders", async () => {
    const target = seed()
    const base = {
      name: "r",
      condition: "keyword" as const,
      matcher: "x",
      targetAgentId: target,
      priority: 1,
      enabled: true,
    }
    expect((await refusal(api().addDelegationRule({ ...base, targetAgentId: "nope" }))).code).toBe(
      "unknown_agent"
    )
    expect((await refusal(api().addDelegationRule({ ...base, matcher: "(" }))).code).toBe(
      "invalid_input"
    )
    const rule = await api().addDelegationRule(base)
    await api().addDelegationRule({ ...base, name: "s" })
    expect((await refusal(api().updateDelegationRule(rule.id, { matcher: "[" }))).code).toBe(
      "invalid_input"
    )
    // The store would drop every rule the list omits.
    expect((await refusal(api().reorderDelegationRules([rule.id]))).code).toBe("invalid_input")
    expect(state().delegationRules).toHaveLength(2)
    expect((await refusal(api().removeDelegationRule("nope"))).code).toBe("unknown_rule")
    expect((await refusal(api().updateDelegationRule("nope", {}))).code).toBe("unknown_rule")
  })
})

describe("onChange", () => {
  it("emits typed change events and stops after dispose", async () => {
    const api = apiWith([READ])
    const events: unknown[] = []
    const dispose = api.onChange((event) => events.push(event))
    // The store module loads lazily; let the subscription attach.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const id = seed()
    state().setConnectionStatus(id, "connected")
    state().setChatFailurePolicy("strict")
    state().addDelegationRule({
      name: "r",
      condition: "always",
      matcher: "",
      targetAgentId: id,
      priority: 1,
      enabled: true,
    })
    state().removeAgent(id)
    await Promise.resolve()

    expect(events).toEqual([
      { type: "config-added", agentId: id },
      { type: "connection-changed", agentId: id },
      { type: "settings-changed" },
      { type: "delegation-changed" },
      { type: "config-removed", agentId: id },
      // Removing an agent also drops the rules that targeted it.
      { type: "delegation-changed" },
    ])

    dispose()
    seed()
    await Promise.resolve()
    expect(events).toHaveLength(6)
  })

  it("keeps notifying after a listener throws", async () => {
    const api = apiWith([READ])
    const seen: string[] = []
    let calls = 0
    const dispose = api.onChange((event) => {
      calls += 1
      if (calls === 1) throw new Error("listener bug")
      seen.push(event.type)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    seed()
    state().setChatFailurePolicy("strict")
    await Promise.resolve()
    expect(seen).toEqual(["settings-changed"])
    dispose()
  })
})
