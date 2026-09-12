import { normalizeCogniaModelBinding } from "@/types/agent/external-agent"
export { normalizeCogniaModelBinding } from "@/types/agent/external-agent"
/** Task-owned launch configuration; credentials are supplied only by the gateway lease. */
import type {
  ExternalAgentConfig,
  ExternalAgentCogniaModelBinding,
} from "@/types/agent/external-agent"
import { resolveModelMeta } from "@/lib/ai/model-options"
import type { AppSettings } from "@cognia/agent-config-types"
import type { GatewayModelMetadata } from "@/types/gateway"
import { findRuntimeForConfig } from "./runtime-catalog"

export const GATEWAY_TASK_ENV = "COGNIA_GATEWAY_TASK_CONFIG"
export const GATEWAY_TOKEN_ENV = "COGNIA_GATEWAY_TOKEN"
const SESSION_PREFIX = "cognia-gateway:"

type GatewayRuntimeConfig = Pick<
  ExternalAgentConfig,
  "protocol" | "transport" | "process" | "metadata" | "network"
>

export function cogniaGatewayRuntime(
  config: GatewayRuntimeConfig
): "codex" | "opencode" | "pi" | "claude" | "qwen" | "dsh" | undefined {
  if (config.protocol === "opencode-v2") {
    return !config.network?.endpoint || config.process?.command ? "opencode" : undefined
  }
  if (!config.process || config.network?.endpoint) return undefined
  const entry = findRuntimeForConfig(config)
  if (!entry) return undefined
  // Both managed DSH profiles share one install catalog row. ACP is a second
  // current transport of that installation, not a different runtime package.
  if (entry.runtimeId === "deepseek-harness") {
    return config.transport === "stdio" &&
      (config.protocol === "dsh-sdk" || config.protocol === "acp")
      ? "dsh"
      : undefined
  }
  if (!config.process.command) return undefined
  if (entry.protocol !== config.protocol) return undefined
  const runtime = entry.runtimeId
  if (config.transport !== "stdio") return undefined
  if (runtime === "codex-app-server" || runtime === "codex-acp") return "codex"
  if (runtime === "qwen-code") return "qwen"
  if (runtime === "opencode-acp") return "opencode"
  if (runtime === "pi") return "pi"
  if (runtime === "claude-agent-acp") return "claude"
  return undefined
}

export function canUseCogniaModels(config: GatewayRuntimeConfig): boolean {
  return cogniaGatewayRuntime(config) !== undefined
}

export function gatewaySessionId(
  taskId: string,
  nativeSessionId: string,
  binding?: ExternalAgentCogniaModelBinding
): string {
  return `${SESSION_PREFIX}${taskId}:${encodeURIComponent(nativeSessionId)}${binding ? `:${encodeURIComponent(JSON.stringify(binding))}` : ""}`
}

export function parseGatewaySessionId(
  sessionId?: string
):
  | { taskId: string; nativeSessionId: string; binding?: ExternalAgentCogniaModelBinding }
  | undefined {
  if (!sessionId?.startsWith(SESSION_PREFIX)) return undefined
  const rest = sessionId.slice(SESSION_PREFIX.length)
  const separator = rest.indexOf(":")
  const taskId = rest.slice(0, separator)
  if (separator < 0 || !/^[a-zA-Z0-9_-]{1,128}$/.test(taskId))
    throw new Error("Invalid gateway task session")
  const [encodedSession, encodedBinding] = rest.slice(separator + 1).split(":")
  const nativeSessionId = decodeURIComponent(encodedSession)
  const binding = encodedBinding
    ? (normalizeCogniaModelBinding(JSON.parse(decodeURIComponent(encodedBinding))) ?? undefined)
    : undefined
  if (!nativeSessionId) throw new Error("Invalid gateway task session")
  return { taskId, nativeSessionId, ...(binding ? { binding } : {}) }
}

export interface GatewayTaskPayload {
  taskId: string
  ownerAccountId: string | null
  binding: ExternalAgentCogniaModelBinding
  runtime: "codex" | "opencode" | "pi" | "claude" | "qwen" | "dsh"
  /** Fixed relative file names only; native hosts derive the state root. No secrets. */
  files: Record<string, string>
}

export function buildGatewayTaskConfig(input: {
  config: ExternalAgentConfig
  binding: ExternalAgentCogniaModelBinding
  taskId: string
  endpoint: string
  secret: string
  model: string
  settings: Pick<AppSettings, "providerSettings" | "customProviders">
  ownerAccountId: string | null
  modelMetadata?: GatewayModelMetadata
}): { config: ExternalAgentConfig; model: string } {
  const { config, binding, taskId, endpoint, secret, model, settings } = input
  const runtime = cogniaGatewayRuntime(config)
  if (!runtime)
    throw new Error("This external agent does not support isolated Cognia gateway tasks")
  const meta =
    input.modelMetadata ??
    resolveModelMeta(
      binding.providerId,
      binding.modelId,
      settings.providerSettings,
      settings.customProviders
    )
  if (meta.supportsTools === false || meta.supportsStreaming === false) {
    throw new Error(
      "The selected model does not support the tools and streaming this agent requires"
    )
  }
  const files: Record<string, string> = {}
  // Deliberately rebuild this map: user/provider credentials and runtime config
  // overrides must never compete with a task's gateway route.
  const env: Record<string, string> = { [GATEWAY_TOKEN_ENV]: secret }
  for (const key of ["COGNIA_TOOLHOST_SOCKET", "COGNIA_TOOLHOST_TOKEN", "COGNIA_TOOLHOST_SERVER"]) {
    const value = config.process?.env?.[key]
    if (value) env[key] = value
  }
  let selectedModel = model
  if (runtime === "dsh") {
    // Current DSH ACP config_options encodes the complete provider/model pair.
    selectedModel = config.protocol === "acp" ? JSON.stringify(["cognia", model]) : model
    // Preserve the certified managed launch and tool-host bridge, but rebuild
    // the provider route from the frozen gateway lease. Runtime paths remain
    // under the managed home; DSH sessions are globally unique UUIDs.
    for (const key of [
      "DSH_HOME",
      "COGNIA_DSH_RUNTIME_HOME",
      "COGNIA_DSH_WORKSPACE",
      "COGNIA_DSH_SESSION_ROOT",
      "COGNIA_DSH_MCP_SERVERS",
      "COGNIA_DSH_PERSONA",
    ]) {
      const value = config.process?.env?.[key]
      if (value) env[key] = value
    }
    const reasoningEffort = config.process?.env?.COGNIA_DSH_REASONING_EFFORT
    if (meta.supportsReasoning === true && reasoningEffort)
      env.COGNIA_DSH_REASONING_EFFORT = reasoningEffort
    env.COGNIA_DSH_GATEWAY_TOKEN = secret
    env.COGNIA_DSH_PROVIDER = "cognia"
    env.COGNIA_DSH_MODEL = model
    if (meta.contextLength) env.COGNIA_DSH_CONTEXT_WINDOW = String(meta.contextLength)
    if (meta.maxOutputTokens) env.COGNIA_DSH_MAX_TOKENS = String(meta.maxOutputTokens)
    env.COGNIA_DSH_GATEWAY_CONFIG = JSON.stringify({
      providers: {
        cognia: {
          api: "openai-completions",
          baseURL: endpoint,
          apiKeyEnv: "COGNIA_DSH_GATEWAY_TOKEN",
          displayName: "Cognia",
          compat: {
            supportsStore: false,
            maxTokensField: "max_tokens",
            supportsReasoningEffort: meta.supportsReasoning === true,
          },
          models: [
            {
              id: model,
              name: model,
              ...(meta.contextLength
                ? {
                    contextWindow: Math.min(
                      meta.contextLength,
                      meta.maxInputTokens ?? meta.contextLength
                    ),
                  }
                : {}),
              ...(meta.maxOutputTokens ? { maxTokens: meta.maxOutputTokens } : {}),
              ...(meta.supportsReasoning === true
                ? {
                    reasoningEfforts: {
                      off: null,
                      minimal: "minimal",
                      low: "low",
                      medium: "medium",
                      high: "high",
                      xhigh: "xhigh",
                      max: "max",
                    },
                  }
                : {}),
              input: meta.supportsVision ? ["text", "image"] : ["text"],
            },
          ],
        },
      },
    })
  } else if (runtime === "codex") {
    files["codex/config.toml"] =
      [
        `model = ${JSON.stringify(model)}`,
        'model_provider = "cognia"',
        `review_model = ${JSON.stringify(model)}`,
        ...(meta.contextLength ? [`model_context_window = ${meta.contextLength}`] : []),
        ...(meta.contextLength
          ? [
              `model_auto_compact_token_limit = ${Math.max(1, Math.min(meta.maxInputTokens ?? meta.contextLength, meta.contextLength - (meta.maxOutputTokens ?? Math.min(16384, Math.floor(meta.contextLength / 4)))))}`,
            ]
          : []),
        "[model_providers.cognia]",
        'name = "Cognia"',
        `base_url = ${JSON.stringify(endpoint)}`,
        `env_key = ${JSON.stringify(GATEWAY_TOKEN_ENV)}`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
      ].join("\n") + "\n"
    if (findRuntimeForConfig(config)?.runtimeId === "codex-acp") {
      // The maintained ACP adapter forwards these overrides on both thread/start
      // and thread/resume, above project config, without serializing credentials.
      env.MODEL_PROVIDER = "cognia"
      env.CODEX_CONFIG = JSON.stringify({
        model,
        review_model: model,
        model_provider: "cognia",
        ...(meta.contextLength
          ? {
              model_context_window: meta.contextLength,
              model_auto_compact_token_limit: Math.max(
                1,
                Math.min(
                  meta.maxInputTokens ?? meta.contextLength,
                  meta.contextLength -
                    (meta.maxOutputTokens ?? Math.min(16384, Math.floor(meta.contextLength / 4)))
                )
              ),
            }
          : {}),
        model_providers: {
          cognia: {
            name: "Cognia",
            base_url: endpoint,
            env_key: GATEWAY_TOKEN_ENV,
            wire_api: "responses",
            requires_openai_auth: false,
          },
        },
      })
    }
  } else if (runtime === "opencode") {
    selectedModel = `cognia/${model}`
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: selectedModel,
      providers: {
        cognia: {
          name: "Cognia",
          package: "@opencode/ai/providers/openai-compatible",
          env: [GATEWAY_TOKEN_ENV],
          settings: { baseURL: endpoint },
          models: {
            [model]: {
              name: model,
              ...(meta.contextLength || meta.maxOutputTokens || meta.maxInputTokens
                ? {
                    limit: {
                      ...(meta.contextLength ? { context: meta.contextLength } : {}),
                      ...(meta.maxInputTokens ? { input: meta.maxInputTokens } : {}),
                      ...(meta.maxOutputTokens ? { output: meta.maxOutputTokens } : {}),
                    },
                  }
                : {}),
              capabilities: {
                tools: true,
                input: meta.supportsVision ? ["text", "image"] : ["text"],
                output: ["text"],
              },
            },
          },
        },
      },
    })
    env.OPENCODE_DISABLE_PROJECT_CONFIG = "true"
  } else if (runtime === "qwen") {
    selectedModel = `${model}(openai)`
    // Qwen's startup auth preflight checks the standard env key even when the
    // provider model itself references a custom envKey.
    env.OPENAI_API_KEY = secret
    env.OPENAI_BASE_URL = endpoint
    env.OPENAI_MODEL = model
    files["qwen/settings.json"] = JSON.stringify({
      $version: 4,
      security: { auth: { selectedType: "openai" } },
      general: { enableAutoUpdate: false, disableAutoUpdate: true },
      telemetry: { enabled: false },
      privacy: { usageStatisticsEnabled: false },
      model: { name: model },
      fastModel: model,
      advisorModel: model,
      compactionModel: model,
      modelProviders: {
        openai: [
          {
            id: model,
            name: model,
            envKey: GATEWAY_TOKEN_ENV,
            baseUrl: endpoint,
            generationConfig: {
              ...(meta.contextLength
                ? {
                    contextWindowSize: Math.min(
                      meta.contextLength,
                      meta.maxInputTokens ?? meta.contextLength
                    ),
                  }
                : {}),
              ...(meta.maxOutputTokens
                ? { samplingParams: { max_tokens: meta.maxOutputTokens } }
                : {}),
              modalities: { image: meta.supportsVision === true },
            },
          },
        ],
      },
    })
  } else if (runtime === "pi") {
    selectedModel = `cognia/${model}`
    files["pi/models.json"] = JSON.stringify({
      providers: {
        cognia: {
          baseUrl: endpoint,
          api: "openai-completions",
          apiKey: `$${GATEWAY_TOKEN_ENV}`,
          models: [
            {
              id: model,
              name: model,
              ...(meta.contextLength
                ? {
                    contextWindow: Math.min(
                      meta.contextLength,
                      meta.maxInputTokens ?? meta.contextLength
                    ),
                  }
                : {}),
              ...(meta.maxOutputTokens ? { maxTokens: meta.maxOutputTokens } : {}),
              ...(meta.supportsReasoning !== undefined
                ? { reasoning: meta.supportsReasoning }
                : {}),
              input: meta.supportsVision ? ["text", "image"] : ["text"],
            },
          ],
        },
      },
    })
    files["pi/settings.json"] = JSON.stringify({
      defaultProvider: "cognia",
      defaultModel: model,
      enabledModels: [`cognia/${model}`],
    })
  } else {
    env.ANTHROPIC_BASE_URL = endpoint.replace(/\/v1\/?$/, "")
    env.ANTHROPIC_AUTH_TOKEN = secret
    env.ANTHROPIC_MODEL = model
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
    if (meta.maxOutputTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(meta.maxOutputTokens)
  }
  env[GATEWAY_TASK_ENV] = JSON.stringify({
    taskId,
    ownerAccountId: input.ownerAccountId,
    binding,
    runtime,
    files,
  } satisfies GatewayTaskPayload)
  const args = [
    ...(runtime === "dsh"
      ? (config.process?.args ?? [])
      : (findRuntimeForConfig(config)?.launchArgs ?? [])),
  ]
  if (runtime === "qwen")
    args.push("--auth-type", "openai", "--model", model, "--openai-base-url", endpoint)
  if (runtime === "codex" && findRuntimeForConfig(config)?.runtimeId === "codex-app-server") {
    // CLI overrides have higher precedence than cwd/project configuration.
    // Keep the same nonsecret values in CODEX_HOME for forked subprocesses.
    let section = ""
    const overrides: string[] = []
    for (const line of files["codex/config.toml"].split("\n").filter(Boolean)) {
      if (line.startsWith("[")) section = line.slice(1, -1)
      else overrides.push("-c", `${section ? `${section}.` : ""}${line}`)
    }
    args.unshift(...overrides)
  }
  return {
    model: selectedModel,
    config: {
      ...config,
      id: `gateway-task-${taskId}`,
      cogniaModel: null,
      network: undefined,
      process: {
        ...config.process!,
        command:
          config.protocol === "opencode-v2"
            ? config.process?.command || "opencode"
            : runtime === "dsh"
              ? config.process!.command
              : (findRuntimeForConfig(config)?.systemCommand ?? config.process!.command),
        args,
        env,
      },
      metadata: {
        ...config.metadata,
        cogniaGatewayTask: taskId,
        piExtensionPolicy: "isolated",
        port: 0,
      },
    },
  }
}
