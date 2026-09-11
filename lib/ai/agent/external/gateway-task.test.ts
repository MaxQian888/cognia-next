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
