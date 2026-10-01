import {
  buildGatewayTaskConfig,
  canUseCogniaModels,
  gatewaySessionId,
  normalizeCogniaModelBinding,
  parseGatewaySessionId,
} from "./gateway-task"
import { getPresetConfig } from "./presets"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

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
    source.process!.args = args as string[]
    expect(prepare(source).config.process!.args!.slice(0, args.length)).toEqual(args)
  })

  it.each([[], ["--yes"], ["--no-install"]])(
    "preserves the supported npx runner prefix %j",
    (...prefix) => {
      const source = config("codex-acp")
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
