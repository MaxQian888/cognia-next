import { normalizeExternalAgentConfigInput } from "./config-normalizer"
import { stateIsolationBlockReason } from "../lifecycle/launch-preparation"
import {
  CONNECTION_PROBLEMS,
  DEFAULT_ADD_AGENT_FORM_DATA,
  addAgentFormForPreset,
  addAgentFormFromConfig,
  addAgentFormLaunchTarget,
  addAgentFormPatch,
  addAgentFormShape,
  buildCreateExternalAgentInput,
  transportForProtocol,
  usesDirectEnvironment,
  validateAddAgentForm,
} from "./add-agent-form"
import { getPresetConfig } from "./presets"
import { protocolAdapterRegistry } from "@/lib/ai/agent/external/protocol-adapter"
import type { AddAgentFormData } from "@/types/agent/component-types"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

const NO_ENV = { names: [], values: {} }

it("round-trips experimental native model control without losing other Codex options", () => {
  const config = {
    id: "codex",
    name: "Codex",
    enabled: true,
    protocol: "codex-app-server",
    transport: "stdio",
    process: { command: "codex", args: ["app-server"] },
    codexOptions: { sandboxMode: "readOnly", stepModelSwitching: true },
  } as ExternalAgentConfig
  const seeded = addAgentFormFromConfig(config)
  expect(seeded.data.codexStepModelSwitching).toBe(true)
  const changed = { ...seeded.data, codexStepModelSwitching: false }
  expect(buildCreateExternalAgentInput(changed).codexOptions).toEqual({ stepModelSwitching: false })
  expect(addAgentFormPatch(config, changed).codexOptions).toEqual({
    sandboxMode: "readOnly",
    stepModelSwitching: false,
  })
})

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

  it("refuses sub-task models the runtime cannot run, and accepts valid ones", () => {
    const claude = addAgentFormForPreset(DEFAULT_ADD_AGENT_FORM_DATA, "claude-code")!.data
    const cogniaModel = { providerId: "gateway", modelId: "big" }
    const valid = form({
      ...claude,
      name: "Claude",
      cogniaModel,
      modelRoles: {
        version: 1,
        slots: {
          "tier.haiku": { kind: "cognia", binding: { providerId: "gateway", modelId: "small" } },
        },
      },
    })
    expect(validateAddAgentForm(valid, "claude-code", NO_ENV)).toBeNull()
    expect(
      validateAddAgentForm(
        {
          ...valid,
          modelRoles: {
            version: 1,
            slots: {
              "tier.haiku": { kind: "cognia", binding: { providerId: "other", modelId: "small" } },
            },
          },
        },
        "claude-code",
        NO_ENV
      )
    ).toBe("modelRolesInvalid")
    expect(
      validateAddAgentForm(
        {
          ...valid,
          modelRoles: { version: 1, slots: { "aux.small": { kind: "inherit-primary" } } },
        },
        "claude-code",
        NO_ENV
      )
    ).toBe("modelRolesInvalid")
    expect(CONNECTION_PROBLEMS.has("modelRolesInvalid")).toBe(true)
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
    expect(input.defaultPermissionMode).toBe(getPresetConfig("claude-code")!.defaultPermissionMode)
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

describe("sub-task models on the form", () => {
  const modelRoles = {
    version: 1 as const,
    slots: { "subagent.default": { kind: "inherit-primary" as const } },
  }

  it("stores them only beside a Cognia binding", () => {
    const base = form({ name: "A", command: "npx", modelRoles })
    expect(buildCreateExternalAgentInput(base).modelRoles).toBeUndefined()
    expect(
      buildCreateExternalAgentInput({ ...base, cogniaModel: { providerId: "p", modelId: "m" } })
        .modelRoles
    ).toEqual(modelRoles)
  })

  it("round-trips through a stored configuration and its edit patch", () => {
    const config = {
      id: "saved",
      name: "A",
      enabled: true,
      protocol: "acp",
      transport: "stdio",
      process: { command: "npx" },
      cogniaModel: { providerId: "p", modelId: "m" },
      modelRoles,
    } as ExternalAgentConfig
    const seeded = addAgentFormFromConfig(config).data
    expect(seeded.modelRoles).toEqual(modelRoles)
    expect(addAgentFormPatch(config, seeded).modelRoles).toEqual(modelRoles)
    expect(addAgentFormPatch(config, { ...seeded, cogniaModel: null }).modelRoles).toBeUndefined()
  })
})

describe("addAgentFormFromConfig / addAgentFormPatch", () => {
  function saved(patch: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
    return {
      id: "eac_1",
      name: "Codex RO",
      protocol: "acp",
      transport: "stdio",
      enabled: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      timeout: 120000,
      retryConfig: {
        maxRetries: 5,
        retryDelay: 250,
        exponentialBackoff: false,
        maxRetryDelay: 9000,
        retryOnErrors: ["ECONNRESET", "timeout"],
      },
      process: {
        command: "codex-acp",
        args: ["--model", "gpt 5"],
        cwd: "/work",
        env: { PLAIN: "1" },
        startupTimeout: 4000,
      },
      metadata: { preset: "codex", importedFromAgentId: "local_1" },
      ...patch,
    } as ExternalAgentConfig
  }

  it("seeds every field the form shows from the saved configuration", () => {
    const seed = addAgentFormFromConfig(saved())
    expect(seed.presetId).toBe("codex")
    expect(seed.processEnv).toEqual({ PLAIN: "1" })
    expect(seed.data).toMatchObject({
      name: "Codex RO",
      protocol: "acp",
      transport: "stdio",
      command: "codex-acp",
      args: "--model 'gpt 5'",
      processCwd: "/work",
      timeoutMs: "120000",
      retryMaxRetries: "5",
      retryDelayMs: "250",
      retryExponentialBackoff: false,
      retryMaxDelayMs: "9000",
      retryOnErrors: "ECONNRESET\ntimeout",
      preset: "codex",
    })
  })

  // A stored config holds keyring refs, never the value; an empty field means
  // "keep what the keyring has".
  it("never seeds a secret into the form", () => {
    const seed = addAgentFormFromConfig(
      saved({
        protocol: "opencode",
        transport: "sse",
        metadata: { autoSpawnServer: true, port: 4100, serverUsername: "me", serverPassword: "x" },
      })
    )
    expect(seed.data.serverPassword).toBe("")
    expect(seed.data.serverUsername).toBe("me")
    expect(seed.data.port).toBe("4100")
    expect(seed.data.autoSpawnServer).toBe(true)
  })

  it("round-trips an unchanged form without losing what the form does not show", () => {
    const config = saved()
    const seed = addAgentFormFromConfig(config)
    const patch = addAgentFormPatch(config, { ...seed.data, processEnv: seed.processEnv })
    expect(patch.process).toEqual({
      command: "codex-acp",
      args: ["--model", "gpt 5"],
      cwd: "/work",
      env: { PLAIN: "1" },
      startupTimeout: 4000,
    })
    expect(patch.metadata).toEqual({
      ...getPresetConfig("codex")?.metadata,
      preset: "codex",
      importedFromAgentId: "local_1",
    })
    expect(patch.timeout).toBe(120000)
    expect(patch.retryConfig).toEqual(config.retryConfig)
    expect(patch).not.toHaveProperty("defaultPermissionMode")
  })

  it("applies an edit and drops form-owned metadata the form cleared", () => {
    const config = saved({
      protocol: "opencode",
      transport: "sse",
      process: { command: "opencode", args: [] },
      metadata: { autoSpawnServer: true, port: 4100, model: "a/b", custom: 1 },
    })
    const seed = addAgentFormFromConfig(config)
    const patch = addAgentFormPatch(config, {
      ...seed.data,
      port: "",
      model: "",
      serverPassword: "typed-now",
    })
    expect(patch.metadata).toEqual({
      autoSpawnServer: true,
      custom: 1,
      serverPassword: "typed-now",
    })
  })

  it("keeps the network config's other fields when the endpoint changes", () => {
    const config = saved({
      protocol: "a2a",
      transport: "http",
      process: undefined,
      network: { endpoint: "https://old.invalid", rpcEndpoint: "https://old.invalid/rpc" },
      metadata: {},
    })
    const seed = addAgentFormFromConfig(config)
    const patch = addAgentFormPatch(config, { ...seed.data, endpoint: "https://new.invalid" })
    expect(patch.network).toEqual({
      endpoint: "https://new.invalid",
      rpcEndpoint: "https://old.invalid/rpc",
    })
    expect(patch).not.toHaveProperty("process")
  })
})

describe("addAgentFormLaunchTarget", () => {
  it("is the command and its arguments for a local agent", () => {
    expect(addAgentFormLaunchTarget(form({ command: " codex-acp ", args: "--a 'b c'" }))).toEqual({
      command: "codex-acp",
      args: ["--a", "b c"],
    })
  })

  it("defaults an auto-spawned OpenCode server to its command", () => {
    expect(
      addAgentFormLaunchTarget(
        form({ protocol: "opencode", transport: "sse", autoSpawnServer: true })
      )
    ).toEqual({ command: "opencode", args: [] })
  })

  it("is empty for an agent that spawns nothing here", () => {
    expect(
      addAgentFormLaunchTarget(
        form({ transport: "http", command: "ignored", endpoint: "https://x" })
      )
    ).toEqual({ command: "", args: [] })
  })
})

describe("native local services and bundled bridges", () => {
  it.each(["crush", "rovo-dev"])(
    "keeps %s on the process plane without a caller endpoint",
    (id) => {
      const applied = addAgentFormForPreset(form({}), id)!
      expect(applied).not.toBeNull()
      const data = {
        ...applied.data,
        preset: id,
        processCwd: "/workspace",
        processEnv: { NATIVE_TOKEN: "private" },
      }
      expect(addAgentFormShape(data, id)).toMatchObject({ usesProcess: true, isLocalService: true })
      expect(validateAddAgentForm(data, id, NO_ENV)).toBeNull()
      const built = buildCreateExternalAgentInput(data)
      expect(built.process).toMatchObject({
        command: applied.data.command,
        cwd: "/workspace",
        env: { NATIVE_TOKEN: "private" },
      })
      expect(built.network).toBeUndefined()
      expect(addAgentFormLaunchTarget(data).command).toBe(applied.data.command)
    }
  )

  it("uses a fixed bundled Codebuff bridge and retains workspace and credentials", () => {
    const applied = addAgentFormForPreset(form({}), "codebuff")!
    expect(applied).not.toBeNull()
    const data = {
      ...applied.data,
      preset: "codebuff",
      command: "untrusted",
      args: "--eval bad",
      processCwd: "/workspace",
      processEnv: { CODEBUFF_API_KEY: "private" },
    }
    expect(addAgentFormShape(data, "codebuff")).toMatchObject({
      bundledBridge: true,
      managedRuntime: false,
      usesProcess: true,
    })
    expect(validateAddAgentForm(data, "codebuff", NO_ENV)).toBeNull()
    expect(buildCreateExternalAgentInput(data).process).toEqual({
      command: "node",
      args: [],
      cwd: "/workspace",
      env: { CODEBUFF_API_KEY: "private" },
    })
    expect(addAgentFormLaunchTarget(data)).toEqual({ command: "node", args: [] })
  })

  it("keeps each preset's explicit permission choice unless the caller overrides it", () => {
    for (const id of ["amp", "continue-dev"]) {
      const applied = addAgentFormForPreset(form({}), id)!
      const data = { ...applied.data, preset: id }
      expect(buildCreateExternalAgentInput(data).defaultPermissionMode).toBe(
        getPresetConfig(id)!.defaultPermissionMode
      )
      expect(
        buildCreateExternalAgentInput(data, { defaultPermissionMode: "default" })
          .defaultPermissionMode
      ).toBe("default")
    }
  })

  it("moves native HTTP services to HTTP transport", () => {
    expect(transportForProtocol("crush-http", "stdio")).toBe("http")
    expect(transportForProtocol("rovo-http", "stdio")).toBe("http")
  })
})

it.each([
  "openclaude",
  "crush",
  "continue-dev",
  "rovo-dev",
  "codebuff",
  "auggie",
  "autohand-code",
  "codebuddy",
  "command-code",
  "kilocode",
  "mistral-vibe",
  "mimo-code",
  "hermes-agent",
  "oh-my-pi",
  "muse",
  "amp",
  "zcode",
])("quick-add %s reaches launch preparation with a supported state choice", (id) => {
  const applied = addAgentFormForPreset(form({}), id)!
  const input = buildCreateExternalAgentInput({ ...applied.data, preset: id })
  const config = normalizeExternalAgentConfigInput(input, { id: "saved-agent" })
  expect(stateIsolationBlockReason(config)).toBeNull()
  if (id === "hermes-agent") expect(config.stateIsolation).toBe("isolated")
  if (id === "oh-my-pi" || id === "codebuff") expect(config.stateIsolation).toBe("shared")
})
