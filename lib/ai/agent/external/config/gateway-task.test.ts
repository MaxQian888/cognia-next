import {
  buildGatewayTaskConfig,
  canUseCogniaModels,
  gatewaySessionId,
  normalizeCogniaModelBinding,
  parseGatewaySessionId,
} from "./gateway-task"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

const config = (preset: string, protocol = "acp", transport = "stdio") =>
  ({
    id: "saved",
    name: "Agent",
    enabled: true,
    protocol,
    transport,
    process: {
      command: "agent",
      env: { OPENAI_API_KEY: "upstream-secret", CODEX_HOME: "/user/home" },
    },
    metadata: { preset },
  }) as ExternalAgentConfig
const binding = { providerId: "custom", modelId: "model", accountId: "account-one" }
const settings = { providerSettings: {}, customProviders: [] }

describe("isolated gateway task configuration", () => {
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
        JSON.parse(prepared.config.process!.env!.OPENCODE_CONFIG_CONTENT).providers.cognia.models
          .model.limit
      ).toEqual({ context: 128000, input: 100000, output: 8000 })
    if (preset === "claude-code")
      expect(prepared.config.process!.env!.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9000")
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
        expect(prepared.config.process!.args).toEqual(["-y", "@agentclientprotocol/codex-acp"])
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
          "-y",
          "@qwen-code/qwen-code",
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
    expect(canUseCogniaModels(config("opencode-server", "opencode", "sse"))).toBe(false)
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
})
