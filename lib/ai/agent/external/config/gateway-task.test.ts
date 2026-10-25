import {
  buildGatewayTaskConfig,
  canUseCogniaModels,
  CLAUDE_GATEWAY_TASK_SETTINGS,
  cogniaGatewaySupport,
  COPILOT_NO_GITHUB_AUTH,
  GATEWAY_RUNTIME_TRAITS,
  gatewayRuntimeTraits,
  gatewaySessionId,
  normalizeCogniaModelBinding,
  openCodeSubagentModelBindings,
  nativeSubagentModelBindings,
  parseGatewaySessionId,
} from "./gateway-task"
import { getPresetConfig } from "./presets"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import { canonicalHash } from "@cognia/router-fusion/util/sha256"
import { compileTaskModelPlan, type TaskModelPlan } from "./model-plan"
import { gatewayModelSlots } from "./model-slots"
import type { AgentModelRoleOverrides } from "@cognia/agent-contracts/model-binding"
import { parse as parseToml } from "smol-toml"
import { cogniaModelReasoningFacts } from "./cognia-model-options"
import { parseFrontmatter } from "@/lib/claude/subagent-importers/_parse-helpers"

const config = (preset: string, protocol = "acp", transport = "stdio") =>
  ({
    id: "saved",
    name: "Agent",
    enabled: true,
    protocol,
    transport,
    process: {
      command:
        getPresetConfig(preset)?.process?.command ??
        (protocol === "opencode-v2" ? "opencode" : "agent"),
      args: getPresetConfig(preset)?.process?.args,
      env: { OPENAI_API_KEY: "upstream-secret", CODEX_HOME: "/user/home" },
    },
    metadata: { preset },
  }) as ExternalAgentConfig
const binding = { providerId: "custom", modelId: "model", accountId: "account-one" }
const settings = { providerSettings: {}, customProviders: [] }

describe("plugin-gated Pi child models", () => {
  function source(family: "nico" | "gotgenes" = "nico") {
    return {
      ...config("pi", "pi-rpc"),
      process: { command: "pi", cwd: "/repo" },
      metadata: {
        preset: "pi",
        cogniaPiSubagents: {
          family,
          version: family === "nico" ? "0.80.0" : "19.2.2",
          packageDir: "/package",
          extensions: ["/package/index.js"],
          agents: {
            reviewer: {
              content: "---\nmodel: custom/review\n---\nReview",
              path: "/repo/.pi/agents/reviewer.md",
              digest: "review-sha",
              model: "custom/review",
            },
            worker: {
              content: "---\ndescription: Worker\ntools: [read, write]\n---\nWork",
              path: "/repo/.pi/agents/worker.md",
              digest: "worker-sha",
            },
            parent: {
              content: "---\nmodel: inherit\n---\nInherit",
              path: "/repo/.pi/agents/parent.md",
              digest: "parent-sha",
              model: "inherit",
            },
          },
        },
      },
    } as ExternalAgentConfig
  }
  it.each(["nico", "gotgenes"] as const)(
    "admits and projects explicit, omitted and inherited %s models",
    (family) => {
      const input = source(family)
      const compiled = compileTaskModelPlan({
        primary: binding,
        slots: gatewayModelSlots(input),
        explicitModels: nativeSubagentModelBindings(input, binding),
        layers: [
          {
            source: "config",
            overrides: {
              version: 1,
              slots: {
                "subagent.default": { kind: "cognia", binding: { ...binding, modelId: "cheap" } },
              },
            },
          },
        ],
      })
      expect(compiled.ok).toBe(true)
      if (!compiled.ok) return
      expect(new Set(compiled.plan.models)).toEqual(new Set(["model", "cheap", "review"]))
      const built = buildGatewayTaskConfig({
        config: input,
        binding,
        taskId: "pi-task",
        model: binding.modelId,
        endpoint: "http://127.0.0.1:9000/v1",
        secret: "lease-only",
        settings,
        ownerAccountId: null,
        modelPlan: compiled.plan,
        modelMetadataById: { review: { id: "review", contextLength: 8000, maxOutputTokens: 1000 } },
      })
      const env = built.config.process!.env!
      const payload = JSON.parse(env.COGNIA_GATEWAY_TASK_CONFIG)
      const catalog = JSON.parse(payload.files["pi/models.json"]).providers
      expect(catalog.cognia.models.map((entry: { id: string }) => entry.id)).toEqual(
        compiled.plan.models
      )
      expect(catalog.custom.baseUrl).toBe("http://127.0.0.1:9000/v1")
      expect(
        catalog.cognia.models.find((entry: { id: string }) => entry.id === "review").contextWindow
      ).toBe(8000)
      expect(parseFrontmatter(payload.files["pi/agents/reviewer.md"]).data.model).toBe(
        "cognia/review"
      )
      expect(parseFrontmatter(payload.files["pi/agents/worker.md"]).data.model).toBeUndefined()
      expect(payload.files["pi/agents/worker.md"]).toContain("tools: [ read, write ]")
      expect(parseFrontmatter(payload.files["pi/agents/parent.md"]).data.model).toBe("inherit")
      expect(JSON.parse(env.COGNIA_TOOLHOST_PI_SUBAGENT_MODELS).agents).toEqual({
        reviewer: "cognia/review",
        worker: null,
        parent: "inherit",
      })
      expect(JSON.stringify(payload.files)).not.toContain("lease-only")
    }
  )
  it("refuses explicit child models omitted from the lease", () => {
    expect(() =>
      buildGatewayTaskConfig({
        config: source(),
        binding,
        taskId: "unadmitted",
        model: binding.modelId,
        endpoint: "http://127.0.0.1:9000/v1",
        secret: "lease",
        settings,
        ownerAccountId: null,
      })
    ).toThrow(/not admitted/)
  })
  it("rejects cross-provider explicit models instead of projecting a fallback", () => {
    const input = source()
    input.metadata!.cogniaPiSubagents = {
      ...(input.metadata!.cogniaPiSubagents as object),
      agents: { reviewer: { content: "", model: "foreign/review" } },
    }
    const result = compileTaskModelPlan({
      primary: binding,
      slots: gatewayModelSlots(input),
      explicitModels: nativeSubagentModelBindings(input, binding),
      layers: [],
    })
    expect(result).toEqual({
      ok: false,
      reason: "cross-provider-unsupported",
      slot: "pi.agent.reviewer",
    })
  })
})

describe("gateway model plan legacy bytes", () => {
  it("preserves every legacy projector's serialized output", () => {
    const outputs = [
      ["claude-code", "acp", "stdio"],
      ["codex-app-server", "codex-app-server", "stdio"],
      ["codex-acp", "acp", "stdio"],
      ["opencode-server", "opencode", "sse"],
      ["opencode-acp", "acp", "stdio"],
      ["opencode-v2-service", "opencode-v2", "sse"],
    ].map(([preset, protocol, transport]) => {
      const output = buildGatewayTaskConfig({
        config: config(preset, protocol, transport),
        binding,
        taskId: "legacy-task",
        endpoint: "http://127.0.0.1:9000/v1",
        secret: "lease-only",
        model: "model",
        settings,
        ownerAccountId: null,
      })
      return [preset, canonicalHash(JSON.stringify(output))]
    })
    expect(outputs).toMatchInlineSnapshot(`
      [
        [
          "claude-code",
          "021862989e94c3827b9eabebe140ecb45491061ff2f41b3b23e882702f77e2bc",
        ],
        [
          "codex-app-server",
          "f285930934a3ae78c0e9fcbbdaf0ff34758e01a60ad62251fb522aeccba437f6",
        ],
        [
          "codex-acp",
          "2357fcf0af249793e8b9a58a72bb6c5dda0bebc045aa8d3cedb31ff4f4b4753a",
        ],
        [
          "opencode-server",
          "c5cf7e721a697f7648714d37bf8134b7364e79cb4cd996fc8a1f30ae6e732a4d",
        ],
        [
          "opencode-acp",
          "fa9e7febca3aa9f2120514fe229a9f7f734c66ea176b40409a78785c4d530c7f",
        ],
        [
          "opencode-v2-service",
          "3a261cd28f91b8f23f905ef01caa19a8290009b231f92ebf113222a9a89baa9e",
        ],
      ]
    `)
  })
})

describe("gateway model plan projectors", () => {
  it.each([
    ["opencode-server", "opencode", "sse"],
    ["opencode-acp", "acp", "stdio"],
    ["opencode-v2-service", "opencode-v2", "sse"],
  ])("preserves native child command precedence for %s", (preset, protocol, transport) => {
    const source = config(preset, protocol, transport)
    const v2 = protocol === "opencode-v2"
    source.process!.env = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        [v2 ? "agents" : "agent"]: { reviewer: { mode: "subagent", model: "cognia/review" } },
        [v2 ? "commands" : "command"]: {
          review: { template: "Review", agent: "reviewer", subtask: true },
          override: {
            template: "Review",
            agent: "reviewer",
            model: "cognia/command-model",
            subtask: true,
          },
        },
      }),
    }
    const result = compileTaskModelPlan({
      primary: binding,
      slots: gatewayModelSlots(source),
      layers: [],
      explicitModels: openCodeSubagentModelBindings(source, binding.providerId),
    })
    if (!result.ok) throw new Error(result.reason)
    expect(result.plan.models).toEqual(["model", "review", "command-model"])
    const built = buildGatewayTaskConfig({
      config: source,
      binding,
      taskId: "commands",
      endpoint: "http://127.0.0.1:9000/v1",
      secret: "lease-only",
      model: "model",
      settings,
      ownerAccountId: null,
      modelPlan: result.plan,
    })
    const commands = JSON.parse(built.config.process!.env!.OPENCODE_CONFIG_CONTENT)[
      v2 ? "commands" : "command"
    ]
    expect(commands.review).not.toHaveProperty("model")
    expect(commands.override.model).toBe("cognia/command-model")
  })
  it.each([
    ["opencode-server", "opencode", "sse"],
    ["opencode-acp", "acp", "stdio"],
    ["opencode-v2-service", "opencode-v2", "sse"],
  ])("preserves each explicit OpenCode child model for %s", (preset, protocol, transport) => {
    const source = config(preset, protocol, transport)
    const v2 = protocol === "opencode-v2"
    const agentKey = v2 ? "agents" : "agent"
    source.process!.env = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        [agentKey]: {
          reviewer: { mode: "subagent", model: "cognia/review" },
          general: { model: "cognia/review" },
          researcher: { mode: "all" },
          worker: { description: "Worker" },
          build: {},
        },
      }),
    }
    const output = buildGatewayTaskConfig({
      config: source,
      binding,
      taskId: "per-agent-models",
      endpoint: "http://127.0.0.1:9000/v1",
      secret: "lease-only",
      model: "model",
      settings,
      ownerAccountId: null,
      modelPlan: {
        version: 2,
        primaryModelId: "model",
        slots: { "subagent.default": { modelId: "child", source: "config" } },
        models: ["model", "child", "review"],
        fingerprint: "per-agent-test",
      },
    })
    const inline = JSON.parse(output.config.process!.env!.OPENCODE_CONFIG_CONTENT)
    expect(inline[agentKey]).toEqual({
      reviewer: { mode: "subagent", model: "cognia/review" },
      general: { model: "cognia/review" },
      researcher: { mode: "all", model: "cognia/child" },
      worker: { description: "Worker", model: "cognia/child" },
      build: { model: "cognia/model" },
      explore: { model: "cognia/child" },
    })
    expect(Object.keys(inline[v2 ? "providers" : "provider"].cognia.models)).toEqual([
      "model",
      "child",
      "review",
    ])
    if (v2) expect(inline).not.toHaveProperty("small_model")
    else expect(inline.small_model).toBe("cognia/model")
  })

  it.each([
    ["opencode-server", "opencode", "sse"],
    ["opencode-acp", "acp", "stdio"],
    ["opencode-v2-service", "opencode-v2", "sse"],
  ])(
    "admits distinct native model definitions and follows primary only when absent for %s",
    (preset, protocol, transport) => {
      const source = config(preset, protocol, transport)
      const v2 = protocol === "opencode-v2"
      const key = v2 ? "agents" : "agent"
      source.process!.env = {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          [key]: {
            reviewer: { mode: "subagent", model: "custom/review" },
            general: { model: "cognia/search" },
            fallback: { mode: "all" },
            build: { model: "other/ignored" },
          },
        }),
      }
      const result = compileTaskModelPlan({
        primary: binding,
        slots: gatewayModelSlots(source),
        layers: [],
        explicitModels: openCodeSubagentModelBindings(source, binding.providerId),
      })
      if (!result.ok) throw new Error(result.reason)
      expect(result.plan.models).toEqual(["model", "search", "review"])
      const built = buildGatewayTaskConfig({
        config: source,
        binding,
        taskId: "explicit-only",
        endpoint: "http://127.0.0.1:9000/v1",
        secret: "lease-only",
        model: "model",
        settings,
        ownerAccountId: null,
        modelPlan: result.plan,
      })
      const inline = JSON.parse(built.config.process!.env!.OPENCODE_CONFIG_CONTENT)
      expect(inline[key].reviewer.model).toBe("cognia/review")
      expect(inline[key].general.model).toBe("cognia/search")
      expect(inline[key].fallback.model).toBe("cognia/model")
      expect(Object.keys(inline[v2 ? "providers" : "provider"].cognia.models)).toEqual(
        result.plan.models
      )
      expect(() =>
        buildGatewayTaskConfig({
          config: source,
          binding,
          taskId: "no-admission",
          endpoint: "http://127.0.0.1:9000/v1",
          secret: "lease-only",
          model: "model",
          settings,
          ownerAccountId: null,
        })
      ).toThrow("not admitted")
    }
  )

  it.each(["cognia/review#high", { providerID: "custom", model: "review", variant: "high" }])(
    "preserves V2 explicit model form and variant %j",
    (model) => {
      const source = config("opencode-v2-service", "opencode-v2", "sse")
      source.process!.env = {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          agents: { reviewer: { mode: "subagent", model } },
        }),
      }
      const result = compileTaskModelPlan({
        primary: binding,
        slots: gatewayModelSlots(source),
        layers: [],
        explicitModels: openCodeSubagentModelBindings(source, binding.providerId),
      })
      if (!result.ok) throw new Error(result.reason)
      expect(result.plan.models).toEqual(["model", "review"])
      expect(result.plan.slots["opencode.agent.reviewer"].variant).toBe("high")
      const built = buildGatewayTaskConfig({
        config: source,
        binding,
        taskId: "variant",
        endpoint: "http://127.0.0.1:9000/v1",
        secret: "lease-only",
        model: "model",
        settings,
        ownerAccountId: null,
        modelPlan: result.plan,
      })
      expect(
        JSON.parse(built.config.process!.env!.OPENCODE_CONFIG_CONTENT).agents.reviewer.model
      ).toEqual(typeof model === "string" ? model : { ...model, providerID: "cognia" })
    }
  )

  it.each([
    "missing-provider",
    "cognia/",
    " cognia/review",
    "cognia/#high",
    "cognia/review#",
    "cognia/ review",
    "cognia/review# high",
    { providerID: "cognia", model: " " },
    { providerID: " cognia", model: "review" },
    { providerID: "cognia", model: "review", variant: " " },
  ])("refuses malformed explicit V2 model references without echoing %p", (model) => {
    const source = config("opencode-v2-service", "opencode-v2", "sse")
    source.process!.env = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ agents: { reviewer: { model } } }),
    }
    expect(() => openCodeSubagentModelBindings(source, binding.providerId)).toThrow(
      "Invalid Cognia model OpenCode subagent model reference"
    )
  })

  const catalogInput = () => ({
    config: config("codex-app-server", "codex-app-server"),
    binding,
    taskId: "catalog",
    endpoint: "http://localhost:1234/v1",
    secret: "lease",
    model: "model",
    settings,
    ownerAccountId: null,
    modelPlan: {
      version: 2 as const,
      primaryModelId: "model",
      models: ["child", "model", "mystery", "plain"],
      slots: { "subagent.default": { modelId: "child", source: "config" as const } },
      fingerprint: "catalog-test",
    },
  })

  it("uses app compiler reasoning facts and resolves each unprovided child's metadata", () => {
    const ownSettings = {
      providerSettings: {},
      customProviders: [
        {
          id: "custom",
          name: "Gateway",
          apiProtocol: "openai",
          baseURL: "https://gw.example/v1",
          apiKey: "test-only",
          enabled: true,
          models: ["child", "plain", "mystery"],
          customModelMetadata: {
            child: { id: "child", name: "Child", contextLength: 64000, supportsReasoning: true },
            plain: { id: "plain", name: "Plain", supportsReasoning: false },
            mystery: { id: "mystery", name: "Mystery" },
          },
        },
      ],
    } as unknown as Parameters<typeof buildGatewayTaskConfig>[0]["settings"]
    const output = buildGatewayTaskConfig({
      ...catalogInput(),
      settings: ownSettings,
      modelMetadata: { id: "model", contextLength: 128000 },
    })
    const payload = JSON.parse(output.config.process!.env!.COGNIA_GATEWAY_TASK_CONFIG)
    const models = payload.codexModelCatalog.models
    expect(models.map((m: { slug: string }) => m.slug)).toEqual([
      "model",
      "child",
      "mystery",
      "plain",
    ])
    expect(models[0]).toMatchObject({ contextWindow: 128000, autoCompactTokenLimit: 111616 })
    expect(models[1]).toMatchObject({
      contextWindow: 64000,
      autoCompactTokenLimit: 48000,
      reasoningEfforts: cogniaModelReasoningFacts("custom", ownSettings).modelEffortValues("child"),
    })
    for (const index of [0, 2, 3]) expect(models[index]).not.toHaveProperty("reasoningEfforts")
    expect(JSON.stringify(payload).length).toBeLessThan(128 * 1024)
  })

  it("projects Codex candidate-only plans and the typed current-turn option", () => {
    const input = catalogInput()
    const output = buildGatewayTaskConfig({
      ...input,
      config: { ...input.config, codexOptions: { stepModelSwitching: true } },
      modelPlan: {
        ...input.modelPlan,
        version: 3,
        slots: {},
        models: ["model", "child"],
        allowedSpawnModels: ["child", "model"],
      },
    })
    const payload = JSON.parse(output.config.process!.env!.COGNIA_GATEWAY_TASK_CONFIG)
    expect(payload.codexModelCatalog.models.map((model: { slug: string }) => model.slug)).toEqual([
      "model",
      "child",
    ])
    const toml = parseToml(payload.files["codex/config.toml"])
    expect(toml.features).toEqual({ step_model_switching: true })
    expect(toml.developer_instructions).toContain('["model","child"]')
    expect(output.config.metadata).toMatchObject({
      cogniaAllowedTaskModels: ["model", "child"],
      cogniaModelPlanFingerprint: "catalog-test",
    })
  })

  it("uses Host metadata for headless reasoning without local model settings", () => {
    const globals = globalThis as Record<string, unknown>
    const previous = globals.__COGNIA_HEADLESS__
    globals.__COGNIA_HEADLESS__ = true
    try {
      const output = buildGatewayTaskConfig({
        ...catalogInput(),
        modelMetadataById: {
          child: { id: "child", supportsReasoning: true, supportsVision: true },
          plain: { id: "plain", supportsReasoning: false },
        },
      })
      const payload = JSON.parse(output.config.process!.env!.COGNIA_GATEWAY_TASK_CONFIG)
      expect(payload.codexModelCatalog.models[1]).toEqual({
        slug: "child",
        inputModalities: ["text", "image"],
        reasoningEfforts: ["low", "medium", "high"],
      })
      expect(payload.codexModelCatalog.models[2]).not.toHaveProperty("reasoningEfforts")
      expect(payload.codexModelCatalog.models[3]).not.toHaveProperty("reasoningEfforts")
    } finally {
      if (previous === undefined) delete globals.__COGNIA_HEADLESS__
      else globals.__COGNIA_HEADLESS__ = previous
    }
  })

  it.each(
    [
      [],
      [""],
      ["x".repeat(257)],
      ["a\nb"],
      ["a\u0085b"],
      Array.from({ length: 33 }, (_, i) => `child-${i}`),
    ].map((models) => ({ models }))
  )("bounds catalog model requests %#", ({ models }) => {
    const input = catalogInput()
    input.modelPlan.models = models
    if (models.length === 0) {
      const payload = JSON.parse(
        buildGatewayTaskConfig(input).config.process!.env!.COGNIA_GATEWAY_TASK_CONFIG
      )
      expect(payload.codexModelCatalog.models.map((m: { slug: string }) => m.slug)).toEqual([
        "model",
      ])
    } else expect(() => buildGatewayTaskConfig(input)).toThrow("Invalid gateway task configuration")
  })

  it.each(["codex-app-server", "codex-acp"])("isolates catalog model windows for %s", (preset) => {
    const source = config(preset, preset === "codex-app-server" ? preset : "acp")
    const modelPlan: TaskModelPlan = {
      version: 2,
      primaryModelId: "model",
      models: ["model", "child", "child"],
      slots: { "subagent.default": { modelId: "child", source: "config" } },
      fingerprint: "catalog-test",
    }
    const prepared = buildGatewayTaskConfig({
      config: source,
      binding,
      taskId: "catalog",
      endpoint: "http://localhost:1234/v1",
      secret: "lease",
      model: "model",
      settings,
      ownerAccountId: null,
      modelPlan,
      modelMetadata: { id: "model", contextLength: 99999 },
      modelMetadataById: {
        model: { id: "model", contextLength: 128000, maxOutputTokens: 8000, supportsVision: true },
        child: { id: "child", contextLength: 32000, maxInputTokens: 27000, maxOutputTokens: 4000 },
      },
    })
    const env = prepared.config.process!.env!
    const payload = JSON.parse(env.COGNIA_GATEWAY_TASK_CONFIG)
    expect(payload.codexModelCatalog).toEqual({
      models: [
        {
          slug: "model",
          contextWindow: 128000,
          autoCompactTokenLimit: 120000,
          inputModalities: ["text", "image"],
        },
        {
          slug: "child",
          contextWindow: 32000,
          autoCompactTokenLimit: 27000,
          inputModalities: ["text"],
        },
      ],
    })
    const toml = parseToml(payload.files["codex/config.toml"])
    expect(toml.model_catalog_json).toBe("model-catalog.json")
    expect(toml).not.toHaveProperty("model_context_window")
    expect(toml).not.toHaveProperty("model_auto_compact_token_limit")
    expect(prepared.config.process!.args!.join(" ")).not.toContain("model_catalog_json")
    if (env.CODEX_CONFIG) {
      const overrides = JSON.parse(env.CODEX_CONFIG)
      for (const key of [
        "model_catalog_json",
        "model_context_window",
        "model_auto_compact_token_limit",
      ])
        expect(overrides).not.toHaveProperty(key)
    }
  })
  const prepare = (source: ExternalAgentConfig, modelPlan?: TaskModelPlan) =>
    buildGatewayTaskConfig({
      config: source,
      binding,
      taskId: "plan-task",
      endpoint: "http://127.0.0.1:9000/v1",
      secret: "lease-only",
      model: "model",
      settings,
      ownerAccountId: null,
      modelPlan,
    })
  const compile = (source: ExternalAgentConfig, selections: AgentModelRoleOverrides["slots"]) => {
    const result = compileTaskModelPlan({
      primary: binding,
      explicitModels: openCodeSubagentModelBindings(source, binding.providerId),
      slots: gatewayModelSlots(source),
      layers: [{ source: "config", overrides: { version: 1, slots: selections } }],
    })
    if (!result.ok) throw new Error(result.reason)
    return result.plan
  }
  const child = (modelId: string, reasoningEffort?: string) => ({
    kind: "cognia" as const,
    binding: { providerId: binding.providerId, modelId },
    reasoningEffort,
  })
  it("refuses an input model that differs from the plan primary", () => {
    const source = config("opencode-acp")
    const modelPlan = compile(source, { "subagent.default": child("child") })
    expect(() =>
      buildGatewayTaskConfig({
        config: source,
        binding,
        taskId: "task",
        endpoint: "http://127.0.0.1:9000/v1",
        secret: "secret",
        model: "other",
        modelPlan,
        settings,
        ownerAccountId: null,
      })
    ).toThrow("primary model differ")
  })

  it.each([false, true])("projects every OpenCode model's own capabilities (v2=%s)", (v2) => {
    const source = config(
      v2 ? "opencode-v2-service" : "opencode-acp",
      v2 ? "opencode-v2" : "acp",
      v2 ? "sse" : "stdio"
    )
    const modelPlan = compile(source, { "subagent.default": child("child") })
    const output = buildGatewayTaskConfig({
      config: source,
      binding,
      taskId: "task",
      endpoint: "http://127.0.0.1:9000/v1",
      secret: "secret",
      model: "model",
      modelPlan,
      settings,
      ownerAccountId: null,
      modelMetadataById: {
        model: {
          id: "model",
          contextLength: 128000,
          maxOutputTokens: 8000,
          supportsVision: true,
          supportsReasoning: false,
        },
        child: {
          id: "child",
          contextLength: 32000,
          maxInputTokens: 28000,
          maxOutputTokens: 4000,
          supportsReasoning: true,
          supportsVision: false,
        },
      },
    })
    const inline = JSON.parse(output.config.process!.env!.OPENCODE_CONFIG_CONTENT)
    const models = inline[v2 ? "providers" : "provider"].cognia.models
    expect(models.child.limit).toEqual({ context: 32000, input: 28000, output: 4000 })
    expect(models.model.limit.context).toBe(128000)
    if (v2)
      expect(models.child.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
    else {
      expect(models.child.reasoning).toBe(true)
      expect(models.child.tool_call).toBe(true)
      expect(models.child.modalities).toEqual({ input: ["text"], output: ["text"] })
    }
  })

  it.each([
    ["claude-code", "acp", "stdio"],
    ["codex-app-server", "codex-app-server", "stdio"],
    ["codex-acp", "acp", "stdio"],
    ["opencode-server", "opencode", "sse"],
    ["opencode-acp", "acp", "stdio"],
    ["opencode-v2-service", "opencode-v2", "sse"],
  ])("keeps empty-plan output byte-identical for %s", (preset, protocol, transport) => {
    const source = config(preset, protocol, transport)
    expect(JSON.stringify(prepare(source, compile(source, {})))).toBe(
      JSON.stringify(prepare(source))
    )
  })

  it("projects Claude tiers and the child default without forcing child selections", () => {
    const source = config("claude-code")
    source.process!.env = {
      CLAUDE_CODE_SUBAGENT_MODEL: "untrusted",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "untrusted",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "untrusted",
    }
    const plan = compile(source, {
      "subagent.default": child("child"),
      "tier.haiku": child("fast"),
      "tier.opus": child("powerful"),
    })
    const env = prepare(source, plan).config.process!.env!
    expect(env).toMatchObject({
      ANTHROPIC_MODEL: "model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "fast",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "powerful",
      CLAUDE_CODE_SUBAGENT_MODEL: "child",
    })
    expect(env).not.toHaveProperty("CLAUDE_CODE_SUBAGENT_MODEL_FORCE")
    expect(prepare(source).config.process!.env!).not.toHaveProperty("CLAUDE_CODE_SUBAGENT_MODEL")
    expect(
      prepare(source, compile(source, { "tier.sonnet": child("balanced") })).config.process!.env!
    ).not.toHaveProperty("CLAUDE_CODE_SUBAGENT_MODEL")
    expect(
      prepare(source, compile(source, { "subagent.default": { kind: "inherit-primary" } })).config
        .process!.env!.CLAUDE_CODE_SUBAGENT_MODEL
    ).toBe("model")
  })

  it("writes Claude settings that turn off the commit attribution the PII gate refuses", () => {
    const source = config("claude-code")
    const env = prepare(source).config.process!.env!
    const payload = JSON.parse(env.COGNIA_GATEWAY_TASK_CONFIG)
    expect(Object.keys(payload.files)).toEqual(["claude/settings.json"])
    expect(JSON.parse(payload.files["claude/settings.json"])).toEqual(CLAUDE_GATEWAY_TASK_SETTINGS)
    expect(CLAUDE_GATEWAY_TASK_SETTINGS).toEqual({
      includeCoAuthoredBy: false,
      attribution: { commit: "", pr: "" },
    })
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1")
  })

  it.each(["codex-app-server", "codex-acp"])(
    "projects Codex agents into every config surface for %s",
    (preset) => {
      const source = config(preset, preset === "codex-app-server" ? preset : "acp")
      for (const effort of [undefined, "high"]) {
        const prepared = prepare(
          source,
          compile(source, { "subagent.default": child("child", effort) })
        )
        const env = prepared.config.process!.env!
        const payload = JSON.parse(env.COGNIA_GATEWAY_TASK_CONFIG)
        const agents = {
          default_subagent_model: "child",
          ...(effort ? { default_subagent_reasoning_effort: effort } : {}),
        }
        expect(parseToml(payload.files["codex/config.toml"])).toMatchObject({
          model: "model",
          agents,
        })
        expect(
          (parseToml(payload.files["codex/config.toml"]) as { agents: unknown }).agents
        ).toEqual(agents)
        expect(Object.keys(payload.files)).toEqual(["codex/config.toml"])
        if (preset === "codex-acp") expect(JSON.parse(env.CODEX_CONFIG).agents).toEqual(agents)
        else {
          const args = prepared.config.process!.args!
          expect(args).toContain('agents.default_subagent_model = "child"')
          if (effort) expect(args).toContain('agents.default_subagent_reasoning_effort = "high"')
          else expect(args.join(" ")).not.toContain("default_subagent_reasoning_effort")
        }
      }
    }
  )

  it("keeps Codex agents unavailable through raw customization", () => {
    const acp = config("codex-acp")
    acp.process!.env = {
      CODEX_CONFIG: JSON.stringify({ agents: { default_subagent_model: "injected" } }),
    }
    expect(() => prepare(acp)).toThrow(/customization/)
    const app = config("codex-app-server", "codex-app-server")
    app.process!.args = ["app-server", "-c", 'agents.default_subagent_model="injected"']
    expect(() => prepare(app)).toThrow(/customization/)
  })

  it.each([
    ["opencode-server", "opencode", "sse"],
    ["opencode-acp", "acp", "stdio"],
    ["opencode-v2-service", "opencode-v2", "sse"],
  ])(
    "projects OpenCode child agents and auxiliary models for %s",
    (preset, protocol, transport) => {
      const source = config(preset, protocol, transport)
      const v2 = protocol === "opencode-v2"
      const agentKey = v2 ? "agents" : "agent"
      const commandKey = v2 ? "commands" : "command"
      source.process!.env = {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          [agentKey]: {
            worker: { mode: "subagent", description: "Worker", model: "cognia/review" },
            leader: { mode: "primary", model: "old/model" },
            all: { mode: "all" },
            unspecified: { description: "No mode" },
            general: {
              description: "Custom general",
              steps: 4,
              mode: "subagent",
              model: "cognia/general",
            },
          },
          [commandKey]: { review: { template: "Review", model: "old/model", subtask: true } },
        }),
      }
      const selections = {
        "subagent.default": child("child"),
        ...(!v2 ? { "aux.small": child("small") } : {}),
      }
      const inline = JSON.parse(
        prepare(source, compile(source, selections)).config.process!.env!.OPENCODE_CONFIG_CONTENT
      )
      expect(inline.model).toBe("cognia/model")
      expect(inline[agentKey]).toEqual({
        worker: { mode: "subagent", description: "Worker", model: "cognia/review" },
        leader: { mode: "primary", model: "cognia/model" },
        all: { mode: "all", model: "cognia/child" },
        unspecified: { description: "No mode", model: "cognia/child" },
        general: {
          description: "Custom general",
          steps: 4,
          mode: "subagent",
          model: "cognia/general",
        },
        explore: { model: "cognia/child" },
      })
      expect(inline[commandKey].review).toEqual({
        template: "Review",
        model: "cognia/model",
        subtask: true,
      })
      expect(Object.keys(inline[v2 ? "providers" : "provider"].cognia.models)).toEqual(
        v2
          ? ["model", "child", "general", "review"]
          : ["model", "small", "child", "general", "review"]
      )
      if (v2) expect(inline).not.toHaveProperty("small_model")
      else expect(inline.small_model).toBe("cognia/small")
      const childOnly = JSON.parse(
        prepare(source, compile(source, { "subagent.default": child("child") })).config.process!
          .env!.OPENCODE_CONFIG_CONTENT
      )
      if (!v2) expect(childOnly.small_model).toBe("cognia/model")
      const bare = config(preset, protocol, transport)
      const builtins = JSON.parse(
        prepare(bare, compile(bare, { "subagent.default": child("child") })).config.process!.env!
          .OPENCODE_CONFIG_CONTENT
      )
      expect(builtins[agentKey]).toEqual({
        general: { model: "cognia/child" },
        explore: { model: "cognia/child" },
      })
      if (!v2) {
        const smallOnly = JSON.parse(
          prepare(source, compile(source, { "aux.small": child("small") })).config.process!.env!
            .OPENCODE_CONFIG_CONTENT
        )
        expect(smallOnly[agentKey].worker.model).toBe("cognia/review")
        expect(smallOnly[agentKey]).not.toHaveProperty("explore")
      }
    }
  )
})

describe("isolated gateway task configuration", () => {
  const prepare = (source: ExternalAgentConfig) =>
    buildGatewayTaskConfig({
      config: source,
      binding,
      taskId: "custom-task",
      endpoint: "http://127.0.0.1:9000/v1",
      secret: "lease-only",
      model: "model",
      settings,
      ownerAccountId: null,
    })

  it("retains a custom Pi executable and explicit skills, extensions, prompts and locale", () => {
    const source = config("pi-rpc", "pi-rpc")
    source.process = {
      command: "/opt/custom/pi",
      cwd: "/workspace",
      args: [
        "--mode",
        "rpc",
        "--skill",
        "./skills/review",
        "-e",
        "./extensions/review.ts",
        "--append-system-prompt",
        "Review carefully",
        "--thinking",
        "high",
      ],
      env: { LANG: "zh_CN.UTF-8", TZ: "Asia/Shanghai", OPENAI_API_KEY: "old-secret" },
    }
    const prepared = prepare(source).config
    expect(prepared.process).toMatchObject({
      command: source.process.command,
      args: source.process.args,
      cwd: "/workspace",
    })
    expect(prepared.process!.env).toMatchObject({ LANG: "zh_CN.UTF-8", TZ: "Asia/Shanghai" })
    expect(prepared.process!.env).not.toHaveProperty("OPENAI_API_KEY")
    expect(prepared.metadata?.piExtensionPolicy).toBe("isolated")
  })

  it("preserves Codex nonrouting configuration without replacing its selected binary", () => {
    const source = config("codex-app-server", "codex-app-server")
    source.process = {
      command: "/opt/custom/codex",
      args: [
        "-c",
        'developer_instructions="Review every change"',
        "app-server",
        "-c",
        'model_reasoning_effort="high"',
      ],
    }
    const prepared = prepare(source).config
    expect(prepared.process!.command).toBe("/opt/custom/codex")
    expect(prepared.process!.args).toEqual(expect.arrayContaining(source.process.args!))
  })

  it.each([
    ["--provider", "other"],
    ["--model", "other"],
    ["--api-key", "secret"],
    ["--session-dir", "/shared"],
    ["--mode", "json"],
    ["--unknown-flag"],
  ])("refuses a conflicting Pi argument rather than silently discarding it: %s", (...extra) => {
    const source = config("pi-rpc", "pi-rpc")
    source.process!.args = ["--mode", "rpc", ...extra]
    expect(() => prepare(source)).toThrow(/customization|argument/)
  })

  it.each([
    'model_provider="other"',
    'developer_instructions="review"\nmodel_provider="other"',
    'developer_instructions={ model_provider="other" }',
  ])("refuses unsafe Codex configuration without echoing its value", (value) => {
    const source = config("codex-app-server", "codex-app-server")
    source.process!.args = ["app-server", "-c", value]
    expect(() => prepare(source)).toThrow(/customization/)
    try {
      prepare(source)
    } catch (error) {
      expect(String(error)).not.toContain(value)
    }
  })

  it("refuses a command disguised by preset metadata", () => {
    const source = config("pi-rpc", "pi-rpc")
    source.process!.command = "/opt/custom/another-agent"
    expect(() => prepare(source)).toThrow(/executable/)
  })

  it("refuses unknown environment customization instead of dropping it", () => {
    const source = config("pi-rpc", "pi-rpc")
    source.process!.env = { CUSTOM_PERSONA: "reviewer" }
    expect(() => prepare(source)).toThrow(/environment customization.*CUSTOM_PERSONA/)
  })

  it("uses the bundled OpenCode ACP provider schema and pins background model requests", () => {
    const env = prepare(config("opencode-acp")).config.process!.env!
    const inline = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
    expect(inline).toMatchObject({
      model: "cognia/model",
      small_model: "cognia/model",
      enabled_providers: ["cognia"],
      provider: {
        cognia: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://127.0.0.1:9000/v1",
            apiKey: "{env:COGNIA_GATEWAY_TOKEN}",
          },
          models: { model: { tool_call: true } },
        },
      },
    })
    expect(inline.providers).toBeUndefined()
    expect(JSON.stringify(inline)).not.toContain("lease-only")
  })

  it("omits incomplete V1 model limits instead of emitting an invalid provider schema", () => {
    const prepared = buildGatewayTaskConfig({
      config: config("opencode-acp"),
      binding,
      taskId: "partial-limits",
      endpoint: "http://127.0.0.1:9000/v1",
      secret: "synthetic",
      model: "model",
      settings,
      ownerAccountId: null,
      modelMetadata: { id: "model", contextLength: 32000 },
    })
    const inline = JSON.parse(prepared.config.process!.env!.OPENCODE_CONFIG_CONTENT)
    expect(inline.provider.cognia.models.model).not.toHaveProperty("limit")
  })

  it.each([
    ["opencode-acp", "acp", "agent", "prompt", "permission", { bash: "ask" }],
    [
      "opencode-v2-service",
      "opencode-v2",
      "agents",
      "system",
      "permissions",
      [{ action: "bash", resource: "*", effect: "ask" }],
    ],
  ])(
    "preserves inline Agent customization for %s with the selected model",
    (preset, protocol, agentsKey, promptKey, permissionKey, permissions) => {
      const source = config(
        preset as string,
        protocol as string,
        protocol === "opencode-v2" ? "sse" : "stdio"
      )
      source.process!.env = {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          default_agent: "reviewer",
          instructions: ["./instructions.md"],
          [agentsKey as string]: {
            reviewer: {
              [promptKey as string]: "Review carefully",
              description: "Code review",
              model: "old-provider/old-model",
              mode: "primary",
              [permissionKey as string]: permissions,
              steps: 12,
            },
          },
          provider: { old: { options: { apiKey: "old-secret" } } },
        }),
      }
      const inline = JSON.parse(prepare(source).config.process!.env!.OPENCODE_CONFIG_CONTENT)
      expect(inline).toMatchObject({
        default_agent: "reviewer",
        instructions: ["./instructions.md"],
        [agentsKey as string]: {
          reviewer: {
            [promptKey as string]: "Review carefully",
            model: "cognia/model",
            [permissionKey as string]: permissions,
            steps: 12,
          },
        },
      })
      expect(JSON.stringify(inline)).not.toContain("old-secret")
      expect(JSON.stringify(inline)).not.toContain("old-provider")
    }
  )

  it("projects Codex ACP persona configuration while replacing only model route fields", () => {
    const source = config("codex-acp")
    source.process!.env = {
      CODEX_CONFIG: JSON.stringify({
        developer_instructions: "Review this code",
        model_reasoning_effort: "high",
        model_provider: "old",
        model: "old-model",
      }),
    }
    const env = prepare(source).config.process!.env!
    expect(JSON.parse(env.CODEX_CONFIG)).toMatchObject({
      developer_instructions: "Review this code",
      model_reasoning_effort: "high",
      model_provider: "cognia",
      model: "model",
    })
    const payload = JSON.parse(env.COGNIA_GATEWAY_TASK_CONFIG)
    expect(payload.files["codex/config.toml"]).toContain(
      'developer_instructions = "Review this code"'
    )
  })

  it.each([
    ["opencode-acp", "acp", "command", { paths: ["./skills"] }],
    ["opencode-v2-service", "opencode-v2", "commands", ["./skills"]],
  ])(
    "retains %s slash commands and skills without their old provider selection",
    (preset, protocol, commandKey, skills) => {
      const source = config(
        preset as string,
        protocol as string,
        protocol === "opencode-v2" ? "sse" : "stdio"
      )
      source.process!.env = {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          skills,
          [commandKey as string]: {
            review: { template: "Review $ARGUMENTS", model: "old/model", subtask: true },
          },
        }),
      }
      const inline = JSON.parse(prepare(source).config.process!.env!.OPENCODE_CONFIG_CONTENT)
      expect(inline.skills).toEqual(skills)
      expect(inline[commandKey as string].review).toEqual({
        template: "Review $ARGUMENTS",
        model: "cognia/model",
        subtask: true,
      })
    }
  )

  it.each([
    "not-json",
    "[]",
    "null",
    JSON.stringify({ plugin: ["unreviewed-plugin"] }),
    JSON.stringify({ agent: { review: { options: { apiKey: "never-print-this" } } } }),
    JSON.stringify({ agent: { review: { permission: { bash: "invalid" } } } }),
    JSON.stringify({ agent: { review: { steps: -1 } } }),
    JSON.stringify({
      agents: { review: { request: { headers: { Authorization: "never-print-this" } } } },
    }),
    JSON.stringify({ instructions: [true] }),
    JSON.stringify({ instructions: ["x".repeat(65_536)] }),
  ])(
    "refuses invalid or unreviewed inline OpenCode settings without exposing values (%#)",
    (raw) => {
      const source = config("opencode-acp")
      source.process!.env = { OPENCODE_CONFIG_CONTENT: raw }
      expect(() => prepare(source)).toThrow(
        "Invalid or unsupported Cognia model OpenCode customization"
      )
    }
  )

  it.each(["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"])(
    "refuses inaccessible %s configuration instead of silently discarding it",
    (key) => {
      const source = config("opencode-acp")
      source.process!.env = { [key]: "/desktop/private-config" }
      expect(() => prepare(source)).toThrow(/inline OpenCode settings/)
    }
  )

  it.each([
    ["opencode-acp", "acp", ["acp", "--log-level", "DEBUG"]],
    [
      "qwen-code",
      "acp",
      [
        "-y",
        "@qwen-code/qwen-code",
        "--acp",
        "--include-directories",
        "/workspace/shared",
        "--allowed-tools",
        "read_file",
      ],
    ],
  ])("preserves documented nonrouting options for %s", (preset, protocol, args) => {
    const source = config(preset as string, protocol as string)
    if (preset === "qwen-code") source.process!.command = "npx"
    source.process!.args = args as string[]
    expect(prepare(source).config.process!.args!.slice(0, args.length)).toEqual(args)
  })

  it.each([[], ["--yes"], ["--no-install"]])(
    "preserves the supported npx runner prefix %j",
    (...prefix) => {
      const source = config("codex-acp")
      source.process!.command = "npx"
      source.process!.args = [...prefix, "@agentclientprotocol/codex-acp"]
      expect(prepare(source).config.process!.args).toEqual(source.process!.args)
    }
  )

  it("retains a globally installed Codex ACP adapter and its runtime settings", () => {
    const source = config("codex-acp")
    source.process = {
      command: "/opt/custom/codex-acp",
      args: [],
      env: { CODEX_PATH: "/opt/custom/codex", NO_BROWSER: "1" },
    }
    expect(prepare(source).config.process).toMatchObject(source.process)
  })

  it.each([
    ["codex-app-server", "codex-app-server"],
    ["opencode-acp", "acp"],
    ["pi-rpc", "pi-rpc"],
    ["claude-code", "acp"],
  ])("generates %s configuration with only the lease credential", (preset, protocol) => {
    const prepared = buildGatewayTaskConfig({
      config: config(preset, protocol),
      binding,
      taskId: "task-one",
      endpoint: "http://127.0.0.1:9000/v1",
      secret: "task-secret",
      model: "model",
      settings,
      ownerAccountId: null,
      modelMetadata: {
        id: "model",
        contextLength: 128000,
        maxInputTokens: 100000,
        maxOutputTokens: 8000,
        supportsTools: true,
        supportsReasoning: true,
        supportsVision: true,
      },
    })
    expect(prepared.config.id).toBe("gateway-task-task-one")
    expect(prepared.config.process?.env?.OPENAI_API_KEY).toBeUndefined()
    expect(prepared.config.process?.env?.CODEX_HOME).toBeUndefined()
    const payload = JSON.parse(prepared.config.process!.env!.COGNIA_GATEWAY_TASK_CONFIG)
    expect(payload.binding).toEqual(binding)
    expect(JSON.stringify(payload)).not.toContain("task-secret")
    expect(JSON.stringify(prepared)).not.toContain("upstream-secret")
    if (preset === "pi-rpc")
      expect(JSON.parse(payload.files["pi/models.json"]).providers.cognia.models[0]).toMatchObject({
        contextWindow: 100000,
        maxTokens: 8000,
        reasoning: true,
      })
    if (preset === "codex-app-server") {
      expect(payload.files["codex/config.toml"]).toContain(
        "model_auto_compact_token_limit = 100000"
      )
      expect(prepared.config.process?.args).toEqual(
        expect.arrayContaining([
          "-c",
          'model_provider = "cognia"',
          'model_providers.cognia.env_key = "COGNIA_GATEWAY_TOKEN"',
        ])
      )
      expect(JSON.stringify(prepared.config.process?.args)).not.toContain("task-secret")
    }
    if (preset === "opencode-acp")
      expect(
        JSON.parse(prepared.config.process!.env!.OPENCODE_CONFIG_CONTENT).provider.cognia.models
          .model.limit
      ).toEqual({ context: 128000, input: 100000, output: 8000 })
    if (preset === "claude-code")
      expect(prepared.config.process!.env!.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9000")
  })

  it("rejects substituted packages and runner flags in persisted npx launches", () => {
    for (const args of [
      ["-y", "@other/agent"],
      ["--offline", "-y", "@agentclientprotocol/codex-acp"],
    ]) {
      const source = config("codex-acp")
      source.process!.command = "npx"
      source.process!.args = args
      expect(() => prepare(source)).toThrow(/catalogued package launch/)
    }
  })

  it.each(["codex-acp", "qwen-code"])(
    "isolates the %s provider and preserves its ACP model identity",
    (preset) => {
      const prepared = buildGatewayTaskConfig({
        config: config(preset),
        binding,
        taskId: "task-acp",
        endpoint: "http://127.0.0.1:9000/v1",
        secret: "task-lease",
        model: "model",
        settings,
        ownerAccountId: "owner",
        modelMetadata: {
          id: "model",
          contextLength: 64000,
          maxInputTokens: 60000,
          maxOutputTokens: 4096,
          supportsTools: true,
          supportsVision: true,
        },
      })
      expect(canUseCogniaModels(config(preset))).toBe(true)
      const env = prepared.config.process!.env!
      const payload = JSON.parse(env.COGNIA_GATEWAY_TASK_CONFIG)
      expect(JSON.stringify(payload)).not.toContain("task-lease")
      if (preset === "codex-acp") {
        expect(prepared.config.process!.command).toBe("codex-acp")
        expect(prepared.config.process!.args).toEqual([])
        expect(env.MODEL_PROVIDER).toBe("cognia")
        expect(JSON.parse(env.CODEX_CONFIG)).toMatchObject({
          model: "model",
          model_provider: "cognia",
          model_providers: {
            cognia: {
              env_key: "COGNIA_GATEWAY_TOKEN",
              base_url: "http://127.0.0.1:9000/v1",
              wire_api: "responses",
              requires_openai_auth: false,
            },
          },
        })
      } else {
        expect(prepared.model).toBe("model(openai)")
        expect(env.OPENAI_API_KEY).toBe("task-lease")
        expect(prepared.config.process!.args).toEqual([
          "--acp",
          "--auth-type",
          "openai",
          "--model",
          "model",
          "--openai-base-url",
          "http://127.0.0.1:9000/v1",
        ])
        expect(
          JSON.parse(payload.files["qwen/settings.json"]).modelProviders.openai[0]
        ).toMatchObject({
          id: "model",
          envKey: "COGNIA_GATEWAY_TOKEN",
          generationConfig: {
            contextWindowSize: 60000,
            samplingParams: { max_tokens: 4096 },
            modalities: { image: true },
          },
        })
      }
    }
  )

  it.each([
    ["deepseek-harness-readonly", "dsh-sdk"],
    ["deepseek-harness-workspace", "dsh-sdk"],
    ["deepseek-harness-acp", "acp"],
  ])(
    "routes %s through the task-owned Cognia lease while preserving its certified launcher",
    (preset, protocol) => {
      const source = config(preset, protocol)
      source.process = {
        command: "/managed/node",
        args: [
          "/managed/deepseek-harness/launcher.mjs",
          "--composition",
          `/managed/deepseek-harness/host.${protocol === "acp" ? "acp" : "sdk-readonly"}.yml`,
        ],
        cwd: "/workspace",
        env: {
          DSH_HOME: "/managed/deepseek-harness/dsh-home",
          COGNIA_DSH_RUNTIME_HOME: "/managed/deepseek-harness",
          COGNIA_DSH_WORKSPACE: "/workspace",
          COGNIA_DSH_SESSION_ROOT: "/managed/deepseek-harness/sessions",
          COGNIA_DSH_MCP_SERVERS: '[{"name":"cognia","command":"node","args":["mcp"]}]',
          COGNIA_DSH_PERSONA: "Cognia",
          COGNIA_DSH_MODEL: "old-model",
          COGNIA_DSH_PROVIDER: "deepseek-official",
          COGNIA_DSH_GATEWAY_CONFIG: "stale config",
          DEEPSEEK_API_KEY: "upstream-key",
          OPENAI_API_KEY: "other-key",
          DEEPSEEK_BASE_URL: "https://untrusted.example",
          COGNIA_TOOLHOST_SOCKET: "/socket",
          COGNIA_TOOLHOST_TOKEN: "tool-lease",
        },
      }
      expect(canUseCogniaModels(source)).toBe(true)
      const prepared = buildGatewayTaskConfig({
        config: source,
        binding,
        taskId: "dsh-task",
        endpoint: "http://127.0.0.1:9000/v1",
        secret: "model-lease",
        model: "gateway-model",
        settings,
        ownerAccountId: "owner",
        modelMetadata: {
          id: "gateway-model",
          contextLength: 128000,
          maxInputTokens: 100000,
          maxOutputTokens: 8000,
          supportsTools: true,
          supportsStreaming: true,
          supportsVision: true,
          supportsReasoning: true,
        },
      })
      expect(prepared.model).toBe(
        protocol === "acp" ? JSON.stringify(["cognia", "gateway-model"]) : "gateway-model"
      )
      expect(prepared.config.process).toMatchObject({
        command: source.process.command,
        args: source.process.args,
        cwd: "/workspace",
      })
      const env = prepared.config.process!.env!
      expect(env).toMatchObject({
        COGNIA_GATEWAY_TOKEN: "model-lease",
        COGNIA_DSH_GATEWAY_TOKEN: "model-lease",
        COGNIA_DSH_PROVIDER: "cognia",
        COGNIA_DSH_MODEL: "gateway-model",
        COGNIA_DSH_CONTEXT_WINDOW: "128000",
        COGNIA_DSH_MAX_TOKENS: "8000",
        DSH_HOME: source.process.env!.DSH_HOME,
        COGNIA_DSH_SESSION_ROOT: source.process.env!.COGNIA_DSH_SESSION_ROOT,
        COGNIA_DSH_MCP_SERVERS: source.process.env!.COGNIA_DSH_MCP_SERVERS,
        COGNIA_TOOLHOST_SOCKET: "/socket",
        COGNIA_TOOLHOST_TOKEN: "tool-lease",
      })
      for (const field of ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_BASE_URL"])
        expect(env[field]).toBeUndefined()
      const providerConfig = JSON.parse(env.COGNIA_DSH_GATEWAY_CONFIG)
      expect(providerConfig).toMatchObject({
        providers: {
          cognia: {
            api: "openai-completions",
            baseURL: "http://127.0.0.1:9000/v1",
            apiKeyEnv: "COGNIA_DSH_GATEWAY_TOKEN",
            models: [
              {
                id: "gateway-model",
                contextWindow: 100000,
                maxTokens: 8000,
                input: ["text", "image"],
                reasoningEfforts: { high: "high" },
              },
            ],
          },
        },
      })
      const payload = JSON.parse(env.COGNIA_GATEWAY_TASK_CONFIG)
      expect(payload).toMatchObject({
        taskId: "dsh-task",
        runtime: "dsh",
        files: {},
        binding,
        ownerAccountId: "owner",
      })
      expect(JSON.stringify(payload)).not.toContain("model-lease")
      expect(env.COGNIA_DSH_GATEWAY_CONFIG).not.toContain("model-lease")
      expect(JSON.stringify(prepared)).not.toContain("upstream-key")
    }
  )

  it("keeps DSH text-only unknown models conservative and rejects unsupported protocols", () => {
    const prepared = buildGatewayTaskConfig({
      config: config("deepseek-harness-readonly", "dsh-sdk"),
      binding,
      taskId: "dsh-basic",
      endpoint: "http://localhost/v1",
      secret: "lease",
      model: "plain",
      settings,
      ownerAccountId: null,
      modelMetadata: { id: "plain", supportsReasoning: false },
    })
    const env = prepared.config.process!.env!
    expect(JSON.parse(env.COGNIA_DSH_GATEWAY_CONFIG).providers.cognia.models).toEqual([
      { id: "plain", name: "plain", input: ["text"] },
    ])
    expect(env.COGNIA_DSH_CONTEXT_WINDOW).toBeUndefined()
    expect(env.COGNIA_DSH_MAX_TOKENS).toBeUndefined()
    expect(canUseCogniaModels(config("deepseek-harness-readonly", "a2a"))).toBe(false)
    expect(canUseCogniaModels(config("deepseek-harness-readonly", "dsh-sdk", "http"))).toBe(false)
  })

  it.each([
    ["deepseek-harness-readonly", "dsh-sdk"],
    ["deepseek-harness-acp", "acp"],
  ])("accepts saved managed %s before the certified launcher is resolved", (preset, protocol) => {
    const source = config(preset, protocol)
    source.process!.command = ""
    expect(canUseCogniaModels(source)).toBe(true)
    const prepared = buildGatewayTaskConfig({
      config: source,
      binding,
      taskId: "managed-blank",
      endpoint: "http://localhost/v1",
      secret: "lease",
      model: "plain",
      settings,
      ownerAccountId: null,
    })
    expect(JSON.parse(prepared.config.process!.env!.COGNIA_GATEWAY_TASK_CONFIG).runtime).toBe("dsh")
    expect(prepared.config.process!.env!.COGNIA_DSH_PROVIDER).toBe("cognia")
    expect(canUseCogniaModels({ ...source, process: undefined })).toBe(false)
    const unmanaged = config("codex-app-server", "codex-app-server")
    unmanaged.process!.command = ""
    expect(canUseCogniaModels(unmanaged)).toBe(false)
  })

  it("prepares current OpenCode V2 local discovery without a preconfigured process", () => {
    const source = { ...config("opencode-v2-service", "opencode-v2", "sse"), process: undefined }
    expect(canUseCogniaModels(source)).toBe(true)
    expect(canUseCogniaModels(config("opencode-server", "opencode", "sse"))).toBe(true)
    expect(canUseCogniaModels({ ...source, network: { endpoint: "https://remote.example" } })).toBe(
      false
    )
    const prepared = buildGatewayTaskConfig({
      config: source,
      binding,
      taskId: "v2-task",
      endpoint: "http://localhost:9000/v1",
      secret: "lease-only",
      model: "model",
      settings,
      ownerAccountId: null,
    })
    expect(prepared.config.process!.command).toBe("opencode")
    const inline = JSON.parse(prepared.config.process!.env!.OPENCODE_CONFIG_CONTENT)
    expect(inline).toMatchObject({
      model: "cognia/model",
      providers: {
        cognia: {
          package: "@opencode/ai/providers/openai-compatible",
          env: ["COGNIA_GATEWAY_TOKEN"],
          settings: { baseURL: "http://localhost:9000/v1" },
          models: { model: { capabilities: { tools: true } } },
        },
      },
    })
    expect(inline.provider).toBeUndefined()
    expect(JSON.stringify(inline)).not.toContain("lease-only")
  })

  it("refuses remote services and models explicitly lacking agent capabilities", () => {
    expect(canUseCogniaModels(config("unknown"))).toBe(false)
    expect(canUseCogniaModels(config("codex-acp", "a2a"))).toBe(false)
    expect(canUseCogniaModels(config("qwen-code", "acp", "http"))).toBe(false)
    expect(
      canUseCogniaModels({
        ...config("opencode-server", "opencode", "http"),
        network: { endpoint: "https://remote.example" },
      })
    ).toBe(false)
    expect(() =>
      buildGatewayTaskConfig({
        config: config("pi-rpc", "pi-rpc"),
        binding,
        taskId: "task",
        endpoint: "http://localhost/v1",
        secret: "lease",
        model: "model",
        settings,
        ownerAccountId: null,
        modelMetadata: { id: "model", supportsTools: false },
      })
    ).toThrow("tools and streaming")
  })

  it.each([
    ["codex-app-server", "codex-app-server", "stdio"],
    ["codex-acp", "acp", "stdio"],
    ["opencode-acp", "acp", "stdio"],
    ["opencode-v2-service", "opencode-v2", "sse"],
    ["qwen-code", "acp", "stdio"],
    ["pi-rpc", "pi-rpc", "stdio"],
    ["claude-code", "acp", "stdio"],
    ["deepseek-harness-readonly", "dsh-sdk", "stdio"],
    ["kimi", "acp", "stdio"],
    ["goose", "acp", "stdio"],
    ["copilot-cli", "acp", "stdio"],
    ["aider", "aider-cli", "stdio"],
    ["opencode-server", "opencode", "sse"],
  ])(
    "keeps %s route valid with sparse and inferred model metadata",
    (preset, protocol, transport) => {
      for (const modelMetadata of [
        undefined,
        { id: "model" },
        { id: "model", contextLength: 64000 },
        { id: "model", contextLength: 64000, maxOutputTokens: 4096 },
        {
          id: "model",
          maxInputTokens: 40000,
          maxOutputTokens: 4096,
          supportsTools: true,
          supportsReasoning: false,
        },
      ]) {
        const prepared = buildGatewayTaskConfig({
          config: config(preset, protocol, transport),
          binding,
          taskId: "sparse",
          endpoint: "http://localhost:1234/v1",
          secret: "lease",
          model: "model",
          settings,
          ownerAccountId: null,
          modelMetadata,
        })
        expect(prepared.config.process?.env?.COGNIA_GATEWAY_TOKEN).toBe("lease")
        expect(
          JSON.stringify(JSON.parse(prepared.config.process!.env!.COGNIA_GATEWAY_TASK_CONFIG))
        ).not.toContain("lease")
      }
    }
  )
  it("rejects unmanaged and incomplete launch identities before building task configuration", () => {
    for (const source of [
      { ...config("pi-rpc", "pi-rpc"), process: undefined },
      config("gemini-cli"),
      config("unknown"),
      { ...config("pi-rpc", "pi-rpc"), process: { command: "" } },
    ]) {
      expect(canUseCogniaModels(source)).toBe(false)
      expect(() =>
        buildGatewayTaskConfig({
          config: source,
          binding,
          taskId: "invalid",
          endpoint: "http://localhost/v1",
          secret: "lease",
          model: "model",
          settings,
          ownerAccountId: null,
        })
      ).toThrow("does not support isolated")
    }
  })
  it("preserves DSH reasoning only when the gateway model offers reasoning", () => {
    for (const supportsReasoning of [false, true]) {
      const source = config("deepseek-harness-readonly", "dsh-sdk")
      source.process!.env!.COGNIA_DSH_REASONING_EFFORT = "high"
      const prepared = buildGatewayTaskConfig({
        config: source,
        binding,
        taskId: "reasoning",
        endpoint: "http://localhost/v1",
        secret: "lease",
        model: "model",
        settings,
        ownerAccountId: null,
        modelMetadata: { id: "model", supportsReasoning },
      })
      expect(prepared.config.process!.env!.COGNIA_DSH_REASONING_EFFORT).toBe(
        supportsReasoning ? "high" : undefined
      )
    }
  })
  it("validates gateway session framing without requiring an optional binding", () => {
    expect(parseGatewaySessionId()).toBeUndefined()
    expect(parseGatewaySessionId(gatewaySessionId("task", "session"))).toEqual({
      taskId: "task",
      nativeSessionId: "session",
    })
    for (const value of [
      "cognia-gateway:task",
      "cognia-gateway:task:",
      "cognia-gateway:task:%invalid",
    ])
      expect(() => parseGatewaySessionId(value)).toThrow()
  })

  it("round-trips the task, native session and frozen account without secrets", () => {
    const encoded = gatewaySessionId("task-one", "native:/session", binding)
    expect(parseGatewaySessionId(encoded)).toEqual({
      taskId: "task-one",
      nativeSessionId: "native:/session",
      binding,
    })
    expect(parseGatewaySessionId("ordinary")).toBeUndefined()
    expect(() => parseGatewaySessionId("cognia-gateway:../escape:session")).toThrow()
    expect(() => normalizeCogniaModelBinding({ ...binding, apiKey: "secret" })).toThrow()
  })

  const meta = {
    id: "model",
    contextLength: 200000,
    maxInputTokens: 180000,
    maxOutputTokens: 16000,
    supportsTools: true,
  }
  const build = (source: ExternalAgentConfig, extra: Record<string, unknown> = {}) =>
    buildGatewayTaskConfig({
      config: source,
      binding,
      taskId: "runtime-task",
      endpoint: "http://127.0.0.1:9000/v1",
      secret: "lease-only",
      model: "model",
      settings,
      ownerAccountId: "owner",
      modelMetadata: meta,
      ...extra,
    })
  const payloadOf = (prepared: ReturnType<typeof build>) =>
    JSON.parse(prepared.config.process!.env!.COGNIA_GATEWAY_TASK_CONFIG)

  describe("Kimi Code (kimi acp)", () => {
    it("routes the env-model provider through Chat Completions with the lease as its key", () => {
      const prepared = build(config("kimi"))
      const env = prepared.config.process!.env!
      expect(prepared.model).toBe("__kimi_env_model__")
      expect(prepared.config.process).toMatchObject({ command: "kimi", args: ["acp"] })
      expect(env).toMatchObject({
        KIMI_MODEL_PROVIDER_TYPE: "openai",
        KIMI_MODEL_BASE_URL: "http://127.0.0.1:9000/v1",
        KIMI_MODEL_API_KEY: "lease-only",
        KIMI_MODEL_NAME: "model",
        KIMI_MODEL_DISPLAY_NAME: "model",
        KIMI_MODEL_MAX_CONTEXT_SIZE: "180000",
        KIMI_MODEL_MAX_OUTPUT_SIZE: "16000",
        KIMI_MODEL_CAPABILITIES: "tool_use",
        KIMI_CODE_NO_AUTO_UPDATE: "1",
        KIMI_DISABLE_TELEMETRY: "1",
      })
      expect(env).not.toHaveProperty("OPENAI_API_KEY")
      expect(payloadOf(prepared)).toMatchObject({ runtime: "kimi", files: {} })
      expect(JSON.stringify(payloadOf(prepared))).not.toContain("lease-only")
    })

    it("declares only the capabilities the model has, instead of Kimi's image/thinking default", () => {
      const env = build(config("kimi"), {
        modelMetadata: {
          id: "model",
          supportsReasoning: true,
          supportsVision: true,
          supportsVideo: true,
          supportsAudio: true,
        },
      }).config.process!.env!
      expect(env.KIMI_MODEL_CAPABILITIES).toBe("tool_use,thinking,image_in,video_in,audio_in")
      expect(env).not.toHaveProperty("KIMI_MODEL_MAX_CONTEXT_SIZE")
      expect(env).not.toHaveProperty("KIMI_MODEL_MAX_OUTPUT_SIZE")
    })

    it("replaces a configured provider route and keeps non-routing Kimi settings", () => {
      const source = config("kimi")
      source.process!.env = {
        KIMI_MODEL_NAME: "kimi-k2",
        KIMI_MODEL_BASE_URL: "https://elsewhere.example/v1",
        KIMI_MODEL_API_KEY: "upstream",
        KIMI_MODEL_PROVIDER_TYPE: "anthropic",
        KIMI_API_KEY: "platform",
        KIMI_BASE_URL: "https://platform.example",
        KIMI_CODE_BASE_URL: "https://code.example",
        KIMI_CODE_CUSTOM_HEADERS: "X-Route: other",
        KIMI_SECONDARY_MODEL: "kimi-other",
        KIMI_CODE_HOME: "/user/.kimi-code",
        KIMI_MCP_TIMEOUT: "30",
        KIMI_LOOP_MAX_STEPS: "40",
        KIMI_DISABLE_TELEMETRY: "0",
      }
      const env = build(source).config.process!.env!
      expect(env).toMatchObject({
        KIMI_MODEL_NAME: "model",
        KIMI_MODEL_BASE_URL: "http://127.0.0.1:9000/v1",
        KIMI_MODEL_API_KEY: "lease-only",
        KIMI_MODEL_PROVIDER_TYPE: "openai",
        KIMI_MCP_TIMEOUT: "30",
        KIMI_LOOP_MAX_STEPS: "40",
        KIMI_DISABLE_TELEMETRY: "1",
      })
      for (const key of [
        "KIMI_API_KEY",
        "KIMI_BASE_URL",
        "KIMI_CODE_BASE_URL",
        "KIMI_CODE_CUSTOM_HEADERS",
        "KIMI_SECONDARY_MODEL",
        "KIMI_CODE_HOME",
      ])
        expect(env).not.toHaveProperty(key)
      expect(JSON.stringify(env)).not.toContain("upstream")
    })

    it("refuses unknown Kimi environment and launch options", () => {
      const env = config("kimi")
      env.process!.env = { KIMI_EXPERIMENTAL_PROVIDER: "x" }
      expect(() => build(env)).toThrow(/environment customization.*KIMI_EXPERIMENTAL_PROVIDER/)
      const args = config("kimi")
      args.process!.args = ["acp", "--model", "other"]
      expect(() => build(args)).toThrow(/customization argument/)
    })
  })

  describe("Goose (goose acp)", () => {
    it("selects the OpenAI-compatible provider from the environment with the keyring closed", () => {
      const source = config("goose")
      source.process!.env = { ...source.process!.env, GOOSE_MODE: "approve" }
      const prepared = build(source)
      const env = prepared.config.process!.env!
      expect(prepared.model).toBe("model")
      expect(prepared.config.process!.args).toEqual(["acp", "--with-builtin", "developer"])
      expect(env).toMatchObject({
        GOOSE_PROVIDER: "openai",
        GOOSE_MODEL: "model",
        OPENAI_HOST: "http://127.0.0.1:9000",
        OPENAI_BASE_PATH: "v1/chat/completions",
        OPENAI_API_KEY: "lease-only",
        GOOSE_DISABLE_KEYRING: "1",
        GOOSE_TELEMETRY_OFF: "1",
        GOOSE_CONTEXT_LIMIT: "180000",
        // The preset's permission default is customization, not a route.
        GOOSE_MODE: "approve",
      })
      expect(payloadOf(prepared).runtime).toBe("goose")
    })

    it("drops second provider routes and refuses unknown Goose settings", () => {
      const source = config("goose")
      source.process!.env = {
        GOOSE_LEAD_PROVIDER: "anthropic",
        GOOSE_LEAD_MODEL: "claude",
        GOOSE_PLANNER_PROVIDER: "openai",
        GOOSE_SUBAGENT_PROVIDER: "openai",
        OPENAI_HOST: "https://api.openai.com",
        OPENAI_CUSTOM_HEADERS: "X-Org: other",
        GOOSE_TEMPERATURE: "0.2",
      }
      const env = build(source).config.process!.env!
      expect(env.OPENAI_HOST).toBe("http://127.0.0.1:9000")
      expect(env.GOOSE_TEMPERATURE).toBe("0.2")
      for (const key of [
        "GOOSE_LEAD_PROVIDER",
        "GOOSE_LEAD_MODEL",
        "GOOSE_PLANNER_PROVIDER",
        "GOOSE_SUBAGENT_PROVIDER",
        "OPENAI_CUSTOM_HEADERS",
      ])
        expect(env).not.toHaveProperty(key)
      source.process!.env = { GOOSE_RECIPE_PATH: "/recipes" }
      expect(() => build(source)).toThrow(/GOOSE_RECIPE_PATH/)
    })
  })

  describe("GitHub Copilot CLI (copilot --acp)", () => {
    it("uses BYOK with the model on the launch and placeholder GitHub credentials", () => {
      const prepared = build(config("copilot-cli"))
      const env = prepared.config.process!.env!
      // No session model option exists on this route; the launch selects it.
      expect(prepared.model).toBeUndefined()
      expect(prepared.config.process!.args).toEqual(["--acp", "--model", "model"])
      expect(env).toMatchObject({
        COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:9000/v1",
        COPILOT_PROVIDER_TYPE: "openai",
        COPILOT_PROVIDER_WIRE_API: "completions",
        COPILOT_PROVIDER_API_KEY: "lease-only",
        COPILOT_MODEL: "model",
        COPILOT_PROVIDER_MAX_PROMPT_TOKENS: "180000",
        COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: "16000",
        COPILOT_OFFLINE: "true",
        COPILOT_AUTO_UPDATE: "false",
        COPILOT_GITHUB_TOKEN: COPILOT_NO_GITHUB_AUTH,
        GH_TOKEN: COPILOT_NO_GITHUB_AUTH,
        GITHUB_TOKEN: COPILOT_NO_GITHUB_AUTH,
      })
      expect(payloadOf(prepared).runtime).toBe("copilot")
    })

    it("replaces BYOK and account settings and refuses a launch-time model", () => {
      const source = config("copilot-cli")
      source.process!.env = {
        COPILOT_PROVIDER_BASE_URL: "https://elsewhere.example/v1",
        COPILOT_PROVIDER_HEADERS: "X-Key: upstream",
        COPILOT_GITHUB_TOKEN: "github-secret",
        COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/docs",
      }
      const env = build(source).config.process!.env!
      expect(env.COPILOT_PROVIDER_BASE_URL).toBe("http://127.0.0.1:9000/v1")
      expect(env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBe("/docs")
      expect(env).not.toHaveProperty("COPILOT_PROVIDER_HEADERS")
      expect(JSON.stringify(env)).not.toContain("github-secret")
      source.process!.env = {}
      source.process!.args = ["--acp", "--model", "gpt-5"]
      expect(() => build(source)).toThrow(/customization argument/)
      source.process!.args = ["--acp"]
      source.process!.env = { COPILOT_ALLOW_ALL: "true" }
      expect(() => build(source)).toThrow(/COPILOT_ALLOW_ALL/)
    })
  })

  describe("Aider (one-shot CLI)", () => {
    it("pins the main, weak and editor models to the gateway's LiteLLM route", () => {
      const prepared = build(config("aider", "aider-cli"))
      expect(prepared.model).toBe("openai/model")
      expect(prepared.config.process!.args).toEqual([
        "--model",
        "openai/model",
        "--weak-model",
        "openai/model",
        "--editor-model",
        "openai/model",
        "--openai-api-base",
        "http://127.0.0.1:9000/v1",
      ])
      expect(prepared.config.process!.env).toMatchObject({ OPENAI_API_KEY: "lease-only" })
      expect(payloadOf(prepared).runtime).toBe("aider")
    })

    it("keeps edit-format options, drops model environment and refuses model arguments", () => {
      const source = config("aider", "aider-cli")
      source.process!.args = ["--edit-format", "diff"]
      source.process!.env = { AIDER_MODEL: "gpt-4o", AIDER_REASONING_EFFORT: "high" }
      const prepared = build(source).config.process!
      expect(prepared.args!.slice(0, 2)).toEqual(["--edit-format", "diff"])
      expect(prepared.env).toMatchObject({ AIDER_REASONING_EFFORT: "high" })
      expect(prepared.env).not.toHaveProperty("AIDER_MODEL")
      for (const args of [
        ["--model", "gpt-4o"],
        ["--openai-api-base", "https://elsewhere.example/v1"],
        ["--model-settings-file", ".aider.model.settings.yml"],
      ]) {
        source.process!.args = args
        expect(() => build(source)).toThrow(/customization argument/)
      }
    })
  })

  it("auto-spawns the OpenCode V1 server preset with the task-owned inline provider", () => {
    const source = config("opencode-server", "opencode", "sse")
    source.metadata = { ...source.metadata, autoSpawnServer: true }
    const prepared = build(source)
    expect(prepared.model).toBe("cognia/model")
    expect(prepared.config.process).toMatchObject({ command: "opencode", args: [] })
    expect(prepared.config.metadata).toMatchObject({ autoSpawnServer: true, port: 0 })
    expect(prepared.config.network).toBeUndefined()
    const inline = JSON.parse(prepared.config.process!.env!.OPENCODE_CONFIG_CONTENT)
    expect(inline).toMatchObject({
      model: "cognia/model",
      enabled_providers: ["cognia"],
      provider: { cognia: { options: { baseURL: "http://127.0.0.1:9000/v1" } } },
    })
    expect(JSON.stringify(inline)).not.toContain("lease-only")
  })

  it("records the origin device and an explicit rebind in the nonsecret task payload", () => {
    expect(payloadOf(build(config("kimi")))).not.toHaveProperty("originDeviceId")
    expect(payloadOf(build(config("kimi")))).not.toHaveProperty("rebind")
    expect(
      payloadOf(build(config("kimi"), { originDeviceId: "phone-1", rebind: true }))
    ).toMatchObject({
      originDeviceId: "phone-1",
      rebind: true,
      ownerAccountId: "owner",
      runtime: "kimi",
    })
  })

  describe("cogniaGatewaySupport", () => {
    it.each([
      ["kimi", "acp", "stdio", "kimi"],
      ["goose", "acp", "stdio", "goose"],
      ["copilot-cli", "acp", "stdio", "copilot"],
      ["aider", "aider-cli", "stdio", "aider"],
      ["opencode-server", "opencode", "sse", "opencode"],
      ["opencode-acp", "acp", "stdio", "opencode"],
      ["codex-app-server", "codex-app-server", "stdio", "codex"],
      ["claude-code", "acp", "stdio", "claude"],
      ["deepseek-harness-readonly", "dsh-sdk", "stdio", "dsh-sdk"],
      ["deepseek-harness-acp", "acp", "stdio", "dsh"],
    ])("supports %s as %s/%s with traits for %s", (preset, protocol, transport, runtime) => {
      const source = config(preset, protocol, transport)
      expect(cogniaGatewaySupport(source)).toEqual({ supported: true, runtime })
      expect(gatewayRuntimeTraits(source)).toBe(GATEWAY_RUNTIME_TRAITS[runtime])
    })

    it("names each runtime's ingress and continuity", () => {
      expect(GATEWAY_RUNTIME_TRAITS.codex).toEqual({
        ingress: "openai-responses",
        continuity: "native-resume",
      })
      expect(GATEWAY_RUNTIME_TRAITS.claude.ingress).toBe("anthropic")
      for (const runtime of ["kimi", "goose", "copilot", "opencode", "pi", "qwen", "dsh"])
        expect(GATEWAY_RUNTIME_TRAITS[runtime]).toEqual({
          ingress: "openai-chat",
          continuity: "native-resume",
        })
      for (const runtime of ["dsh-sdk", "aider"])
        expect(GATEWAY_RUNTIME_TRAITS[runtime]).toEqual({
          ingress: "openai-chat",
          continuity: "transcript",
        })
    })

    it.each([
      ["gemini-cli", "acp"],
      ["cline", "acp"],
      ["cursor-cli", "acp"],
      ["kiro", "acp"],
      ["devin", "acp"],
      ["qoder", "acp"],
      ["droid", "acp"],
      ["unknown", "acp"],
    ])("refuses %s as an unsupported runtime", (preset, protocol) => {
      expect(cogniaGatewaySupport(config(preset, protocol))).toEqual({
        supported: false,
        reason: "unsupported-runtime",
      })
    })

    it("distinguishes attached servers, network endpoints and missing processes", () => {
      expect(
        cogniaGatewaySupport({
          ...config("opencode-remote", "opencode", "sse"),
          process: undefined,
          network: { endpoint: "http://127.0.0.1:4096" },
        })
      ).toEqual({ supported: false, reason: "remote-server" })
      expect(
        cogniaGatewaySupport({
          ...config("opencode-v2-service", "opencode-v2", "sse"),
          process: undefined,
          network: { endpoint: "https://remote.example" },
        })
      ).toEqual({ supported: false, reason: "remote-server" })
      expect(
        cogniaGatewaySupport({
          ...config("kimi", "acp", "websocket"),
          process: undefined,
          network: { endpoint: "wss://agent.example" },
        })
      ).toEqual({ supported: false, reason: "network-endpoint" })
      expect(cogniaGatewaySupport({ ...config("kimi"), process: undefined })).toEqual({
        supported: false,
        reason: "no-process",
      })
      expect(
        cogniaGatewaySupport({ ...config("pi-rpc", "pi-rpc"), process: { command: "" } })
      ).toEqual({ supported: false, reason: "no-process" })
    })
  })
})
