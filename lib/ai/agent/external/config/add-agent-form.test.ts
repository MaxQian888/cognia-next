import {
  CONNECTION_PROBLEMS,
  DEFAULT_ADD_AGENT_FORM_DATA,
  addAgentFormForPreset,
  addAgentFormShape,
  buildCreateExternalAgentInput,
  transportForProtocol,
  usesDirectEnvironment,
  validateAddAgentForm,
} from "./add-agent-form"
import { getPresetConfig } from "./presets"
import { protocolAdapterRegistry } from "@/lib/ai/agent/external/protocol-adapter"
import type { AddAgentFormData } from "@/types/agent/component-types"

const NO_ENV = { names: [], values: {} }

function form(patch: Partial<AddAgentFormData>): AddAgentFormData {
  return { ...DEFAULT_ADD_AGENT_FORM_DATA, ...patch }
}

describe("addAgentFormForPreset", () => {
  it("seeds every field a preset implies and keeps the rest of the form", () => {
    const preset = getPresetConfig("claude-code")!
    const applied = addAgentFormForPreset(form({ retryMaxRetries: "7" }), "claude-code")!
    expect(applied.data.name).toBe(preset.name)
    expect(applied.data.protocol).toBe(preset.protocol)
    expect(applied.data.transport).toBe(preset.transport)
    expect(applied.data.command).toBe(preset.process?.command ?? "")
    // Fields the preset does not speak to are the user's, not reset.
    expect(applied.data.retryMaxRetries).toBe("7")
    expect(applied.processEnv).toEqual(preset.process?.env)
  })

  it("seeds nothing for custom, a blank id or an unknown preset", () => {
    expect(addAgentFormForPreset(DEFAULT_ADD_AGENT_FORM_DATA, "custom")).toBeNull()
    expect(addAgentFormForPreset(DEFAULT_ADD_AGENT_FORM_DATA, "")).toBeNull()
    expect(addAgentFormForPreset(DEFAULT_ADD_AGENT_FORM_DATA, "not-a-preset")).toBeNull()
  })
})

describe("transportForProtocol", () => {
  it("moves network protocols off stdio and leaves the rest alone", () => {
    expect(transportForProtocol("opencode", "stdio")).toBe("sse")
    expect(transportForProtocol("opencode-v2", "stdio")).toBe("sse")
    expect(transportForProtocol("a2a", "stdio")).toBe("http")
    expect(transportForProtocol("acp", "websocket")).toBe("websocket")
  })
})

describe("addAgentFormShape / usesDirectEnvironment", () => {
  it("classifies stdio, OpenCode and managed-runtime forms", () => {
    expect(addAgentFormShape(form({ transport: "stdio" }), "").isStdio).toBe(true)
    const opencode = addAgentFormShape(form({ protocol: "opencode", transport: "sse" }), "")
    expect(opencode).toMatchObject({ isOpenCode: true, isStdio: false })
    const managedId = ["deepseek-harness-acp", "deepseek-harness-workspace"].find(
      (id) => getPresetConfig(id)?.metadata?.requiresManagedRuntime === true
    )
    if (managedId) expect(addAgentFormShape(form({}), managedId).managedRuntime).toBe(true)
  })

  it("puts the environment in plain view for Aider and the environment-led presets", () => {
    expect(usesDirectEnvironment(form({ protocol: "aider-cli" }), "")).toBe(true)
    expect(usesDirectEnvironment(form({}), "qoder")).toBe(true)
    expect(usesDirectEnvironment(form({}), "claude-code")).toBe(false)
  })
})

describe("validateAddAgentForm", () => {
  // OpenCode (v1) is not a built-in protocol: its adapter is registered at
  // runtime, so the form accepts it only once the registry has it.
  beforeEach(() => {
    const has = protocolAdapterRegistry.has.bind(protocolAdapterRegistry)
    jest
      .spyOn(protocolAdapterRegistry, "has")
      .mockImplementation((protocol: string) => protocol === "opencode" || has(protocol))
  })
  afterEach(() => jest.restoreAllMocks())

  it("accepts a complete stdio agent", () => {
    expect(validateAddAgentForm(form({ name: "A", command: "npx" }), "", NO_ENV)).toBeNull()
  })

  it.each([
    [
      "unknown protocol",
      form({ name: "A", command: "x", protocol: "nope" as never }),
      "unsupportedProtocol",
    ],
    ["blank name", form({ name: "  ", command: "npx" }), "nameRequired"],
    ["stdio without a command", form({ name: "A" }), "commandRequired"],
    ["network without an endpoint", form({ name: "A", transport: "http" }), "endpointRequired"],
    [
      "remote OpenCode without an endpoint",
      form({ name: "A", protocol: "opencode", transport: "sse" }),
      "endpointRequired",
    ],
    ["unbalanced quotes", form({ name: "A", command: "npx", args: '"open' }), "argumentsInvalid"],
  ])("refuses %s", (_label, data, problem) => {
    expect(validateAddAgentForm(data, "", NO_ENV)).toBe(problem)
  })

  it("lets an auto-spawned OpenCode server and the V2 preview through without an endpoint", () => {
    expect(
      validateAddAgentForm(
        form({ name: "A", protocol: "opencode", transport: "sse", autoSpawnServer: true }),
        "",
        NO_ENV
      )
    ).toBeNull()
    expect(
      validateAddAgentForm(
        form({ name: "A", protocol: "opencode-v2", transport: "sse" }),
        "",
        NO_ENV
      )
    ).toBeNull()
  })

  it("refuses duplicate, malformed or NUL-carrying environment entries", () => {
    const ok = form({ name: "A", command: "npx" })
    expect(validateAddAgentForm(ok, "", { names: ["K", " K"], values: { K: "v" } })).toBe(
      "environmentInvalid"
    )
    expect(validateAddAgentForm(ok, "", { names: ["A=B"], values: {} })).toBe("environmentInvalid")
    expect(validateAddAgentForm(ok, "", { names: ["K"], values: { K: "a\0b" } })).toBe(
      "environmentInvalid"
    )
    // Blank rows are rows the user has not filled in yet, not an error.
    expect(validateAddAgentForm(ok, "", { names: ["", "K"], values: { K: "v" } })).toBeNull()
  })

  it("refuses a half-filled Cognia model binding", () => {
    const data = form({
      name: "A",
      command: "npx",
      cogniaModel: { providerId: "", modelId: "m" } as AddAgentFormData["cogniaModel"],
    })
    expect(validateAddAgentForm(data, "", NO_ENV)).toBe("cogniaModelInvalid")
  })

  it("files every problem except the name under the connection settings", () => {
    expect(CONNECTION_PROBLEMS.has("nameRequired")).toBe(false)
    expect(CONNECTION_PROBLEMS.has("commandRequired")).toBe(true)
    expect(CONNECTION_PROBLEMS.has("endpointRequired")).toBe(true)
  })
})

describe("buildCreateExternalAgentInput", () => {
  it("builds a stdio agent with tokenized arguments, retries and the preset recorded", () => {
    const input = buildCreateExternalAgentInput(
      form({
        name: "Claude",
        preset: "claude-code",
        command: "npx",
        args: '@anthropics/claude-code "--flag value"',
        processEnv: { K: "v" },
        bare: true,
        retryOnErrors: "ECONNRESET, timeout\nEPIPE",
        timeoutMs: "1000",
      })
    )
    expect(input.process).toMatchObject({
      command: "npx",
      args: ["@anthropics/claude-code", "--flag value"],
      env: { K: "v" },
      bare: true,
    })
    expect(input.process?.debug).toBeUndefined()
    expect(input.timeout).toBe(1000)
    expect(input.retryConfig?.retryOnErrors).toEqual(["ECONNRESET", "timeout", "EPIPE"])
    expect(input.metadata?.preset).toBe("claude-code")
    expect(input.defaultPermissionMode).toBeUndefined()
  })

  it("falls back to defaults for unusable numbers", () => {
    const input = buildCreateExternalAgentInput(
      form({ name: "A", command: "x", timeoutMs: "-1", retryMaxRetries: "abc" })
    )
    expect(input.timeout).toBe(300000)
    expect(input.retryConfig?.maxRetries).toBe(3)
  })

  it("builds a network agent with its endpoint and no process", () => {
    const input = buildCreateExternalAgentInput(
      form({ name: "A", transport: "http", endpoint: "http://x" })
    )
    expect(input.network).toEqual({ endpoint: "http://x" })
    expect(input.process).toBeUndefined()
  })

  it("builds an auto-spawned OpenCode server with its port and credentials in metadata", () => {
    const input = buildCreateExternalAgentInput(
      form({
        name: "OC",
        protocol: "opencode",
        transport: "sse",
        autoSpawnServer: true,
        port: "4096",
        hostname: " 127.0.0.1 ",
        serverPassword: "pw",
        serverUsername: "user",
        model: "a/b",
      })
    )
    expect(input.process?.command).toBe("opencode")
    expect(input.metadata).toMatchObject({
      autoSpawnServer: true,
      port: 4096,
      hostname: "127.0.0.1",
      serverPassword: "pw",
      serverUsername: "user",
      model: "a/b",
    })
  })

  it("stores the permission mode the caller chose, and Aider's own default otherwise", () => {
    expect(
      buildCreateExternalAgentInput(form({ name: "A", command: "x" }), {
        defaultPermissionMode: "acceptEdits",
      }).defaultPermissionMode
    ).toBe("acceptEdits")
    expect(
      buildCreateExternalAgentInput(form({ name: "A", command: "aider", protocol: "aider-cli" }))
        .defaultPermissionMode
    ).toBe("plan")
  })
})
