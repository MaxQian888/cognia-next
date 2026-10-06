import { normalizeCogniaModelBinding } from "@/types/agent/external-agent"
export { normalizeCogniaModelBinding } from "@/types/agent/external-agent"
/** Task-owned launch configuration; credentials are supplied only by the gateway lease. */
import type {
  ExternalAgentConfig,
  ExternalAgentCogniaModelBinding,
} from "@/types/agent/external-agent"
import { parse as parseToml } from "smol-toml"
import { z } from "zod"
import { resolveModelMeta } from "@/lib/ai/model-options"
import type { AppSettings } from "@cognia/agent-config-types"
import type { GatewayModelMetadata } from "@/types/gateway"
import { findRuntimeForConfig } from "./install-catalog"

export const GATEWAY_TASK_ENV = "COGNIA_GATEWAY_TASK_CONFIG"
/** Placeholder GitHub token for Copilot BYOK tasks; never a credential. */
export const COPILOT_NO_GITHUB_AUTH = "cognia-gateway-task-no-github-auth"
export const GATEWAY_TOKEN_ENV = "COGNIA_GATEWAY_TOKEN"
const SESSION_PREFIX = "cognia-gateway:"

type GatewayRuntimeConfig = Pick<
  ExternalAgentConfig,
  "protocol" | "transport" | "process" | "metadata" | "network"
>

/** Runtime names the native task hosts accept (sandboxd and the CLI twin). */
export type CogniaGatewayRuntime =
  "codex" | "opencode" | "pi" | "claude" | "qwen" | "dsh" | "kimi" | "goose" | "copilot" | "aider"

export type CogniaGatewayUnsupportedReason =
  "unsupported-runtime" | "remote-server" | "no-process" | "network-endpoint"

/**
 * How a runtime reaches the gateway and how a resumed task continues.
 *
 * `native-resume` reopens the agent's own session inside the retained task
 * home, so the agent keeps its native history across leases and model rebinds.
 * `transcript` starts a fresh native turn and replays Cognia's conversation
 * transcript instead. Keys are the runtime names {@link cogniaGatewaySupport}
 * reports; DeepSeek Harness's SDK profile is distinguished as `dsh-sdk`
 * because, unlike its ACP profile, it has no resumable native session.
 */
export const GATEWAY_RUNTIME_TRAITS: Record<
  string,
  {
    ingress: "openai-responses" | "openai-chat" | "anthropic"
    continuity: "native-resume" | "transcript"
  }
> = {
  codex: { ingress: "openai-responses", continuity: "native-resume" },
  opencode: { ingress: "openai-chat", continuity: "native-resume" },
  pi: { ingress: "openai-chat", continuity: "native-resume" },
  claude: { ingress: "anthropic", continuity: "native-resume" },
  qwen: { ingress: "openai-chat", continuity: "native-resume" },
  dsh: { ingress: "openai-chat", continuity: "native-resume" },
  "dsh-sdk": { ingress: "openai-chat", continuity: "transcript" },
  kimi: { ingress: "openai-chat", continuity: "native-resume" },
  goose: { ingress: "openai-chat", continuity: "native-resume" },
  copilot: { ingress: "openai-chat", continuity: "native-resume" },
  // Aider is a one-shot CLI whose Cognia-owned history lives beside the
  // workspace, not in the task home, so a task continues from the transcript.
  aider: { ingress: "openai-chat", continuity: "transcript" },
}

export function cogniaGatewayRuntime(
  config: GatewayRuntimeConfig
): CogniaGatewayRuntime | undefined {
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
  // OpenCode's V1 server preset (`metadata.autoSpawnServer`) launches
  // `opencode serve` itself whenever a command is configured and talks to it
  // over HTTP + SSE; it is still a task-owned local process. An attached
  // server (an endpoint) was refused above.
  if (runtime === "opencode") return config.transport === "sse" ? "opencode" : undefined
  if (config.transport !== "stdio") return undefined
  if (runtime === "codex-app-server" || runtime === "codex-acp") return "codex"
  if (runtime === "qwen-code") return "qwen"
  if (runtime === "opencode-acp") return "opencode"
  if (runtime === "pi") return "pi"
  if (runtime === "claude-agent-acp") return "claude"
  if (runtime === "kimi") return "kimi"
  if (runtime === "goose") return "goose"
  if (runtime === "copilot-cli") return "copilot"
  if (runtime === "aider") return "aider"
  return undefined
}

/**
 * Whether this configuration can run a task on a Cognia model, and why not.
 *
 * `runtime` is the {@link GATEWAY_RUNTIME_TRAITS} key for the configuration.
 * The refusal reasons are ordered by what the user would have to change: an
 * attached server or network endpoint cannot be given a task-owned config
 * home at all; a configuration without a process has nothing to launch; any
 * other refusal is a runtime without a verified isolated launch contract.
 */
export function cogniaGatewaySupport(
  config: GatewayRuntimeConfig
):
  | { supported: true; runtime: string }
  | { supported: false; reason: CogniaGatewayUnsupportedReason } {
  const runtime = cogniaGatewayRuntime(config)
  if (runtime)
    return {
      supported: true,
      runtime: runtime === "dsh" && config.protocol === "dsh-sdk" ? "dsh-sdk" : runtime,
    }
  if (config.network?.endpoint)
    return {
      supported: false,
      reason:
        config.protocol === "opencode" || config.protocol === "opencode-v2"
          ? "remote-server"
          : "network-endpoint",
    }
  if (!config.process?.command && findRuntimeForConfig(config)?.runtimeId !== "deepseek-harness")
    return { supported: false, reason: "no-process" }
  return { supported: false, reason: "unsupported-runtime" }
}

/** Ingress and continuity for a supported configuration. */
export function gatewayRuntimeTraits(
  config: GatewayRuntimeConfig
): (typeof GATEWAY_RUNTIME_TRAITS)[string] | undefined {
  const support = cogniaGatewaySupport(config)
  return support.supported ? GATEWAY_RUNTIME_TRAITS[support.runtime] : undefined
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
  runtime: CogniaGatewayRuntime
  /**
   * The paired device a Host-run task belongs to. The native host refuses to
   * resume (or rebind) a retained task for another device.
   */
  originDeviceId?: string
  /**
   * Replace the retained model binding of an existing task. Hosts accept this
   * only when the owner account, origin device and runtime are unchanged, so
   * the native history keeps one owner while it moves to another Cognia model.
   */
  rebind?: true
  /** Fixed relative file names only; native hosts derive the state root. No secrets. */
  files: Record<string, string>
}

// These are argv grammars, not shell commands. Unknown flags are refused so a
// new upstream option cannot quietly override the task's provider or transport.
// Sources: pi.dev/docs/latest/cli, opencode.ai/docs/cli, the Qwen CLI config,
// and the Codex app-server/ACP runtime documentation.
const CUSTOM_ARGUMENTS: Record<string, { values: readonly string[]; switches: readonly string[] }> =
  {
    pi: {
      values: [
        "--skill",
        "--prompt-template",
        "--system-prompt",
        "--append-system-prompt",
        "--thinking",
        "--extension",
        "-e",
        "--tools",
        "-t",
        "--exclude-tools",
        "-xt",
      ],
      switches: [
        "--no-context-files",
        "-nc",
        "--no-extensions",
        "-ne",
        "--no-skills",
        "-ns",
        "--no-prompt-templates",
        "-np",
        "--no-tools",
        "-nt",
        "--no-builtin-tools",
        "-nbt",
        "--no-approve",
        "-na",
        "--offline",
      ],
    },
    codex: { values: [], switches: [] },
    opencode: { values: ["--log-level"], switches: ["--print-logs"] },
    qwen: {
      values: [
        "--include-directories",
        "--allowed-tools",
        "--allowed-mcp-server-names",
        "--mcp-config",
        "--extensions",
      ],
      switches: [],
    },
    claude: { values: [], switches: [] },
    // `kimi acp` takes no options of its own; everything else is a TUI flag.
    kimi: { values: [], switches: [] },
    goose: { values: ["--with-builtin"], switches: [] },
    // `--model` is the task's route; the remaining flags are TUI or auth options.
    copilot: { values: [], switches: [] },
    // Model, weak/editor model, endpoint and model settings files are the route.
    aider: {
      values: [
        "--edit-format",
        "--editor-edit-format",
        "--reasoning-effort",
        "--thinking-tokens",
        "--max-chat-history-tokens",
        "--timeout",
      ],
      switches: [],
    },
  }
const CODEX_CUSTOM_CONFIG_KEYS = new Set([
  "developer_instructions",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "personality",
  "approval_policy",
  "sandbox_mode",
])

function customizedGatewayLaunch(
  config: ExternalAgentConfig,
  runtime: string
): { command: string; args: string[] } {
  if (runtime === "dsh")
    return { command: config.process?.command ?? "", args: [...(config.process?.args ?? [])] }
  const entry = findRuntimeForConfig(config)
  const command = config.process?.command || (config.protocol === "opencode-v2" ? "opencode" : "")
  const basename = command
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.(exe|cmd)$/i, "")
  const systemCommand =
    entry?.systemCommand ?? (config.protocol === "opencode-v2" ? "opencode" : undefined)
  const legacyLaunch = entry?.legacyLaunches?.find((launch) => launch.command === basename)
  if (basename !== systemCommand && !legacyLaunch) {
    throw new Error(
      "Cognia model customization requires an executable matching the selected runtime"
    )
  }
  const required = [...(legacyLaunch?.args ?? entry?.launchArgs ?? [])]
  const configured = config.process?.args ?? required
  if (basename === "npx" && required[0] === "-y") {
    if (configured[0] === "--yes" || configured[0] === "--no-install") required[0] = configured[0]
    else if (configured[0] === required[1]) required.shift()
  }
  const args: string[] = []
  let prefixIndex = 0
  const grammar = CUSTOM_ARGUMENTS[runtime]
  for (let i = 0; i < configured.length; i++) {
    const token = configured[i]
    if (token === required[prefixIndex]) {
      args.push(token)
      prefixIndex++
      continue
    }
    // npx package selection is fixed before any agent-owned option is parsed.
    if (basename === "npx" && prefixIndex < required.length) {
      throw new Error("Cognia model customization cannot replace the catalogued package launch")
    }
    const separator = token.indexOf("=")
    const flag = separator < 0 ? token : token.slice(0, separator)
    if (entry?.runtimeId === "codex-app-server" && (flag === "-c" || flag === "--config")) {
      const value = separator < 0 ? configured[++i] : token.slice(separator + 1)
      const key = value?.split("=", 1)[0]?.trim()
      if (!key || !CODEX_CUSTOM_CONFIG_KEYS.has(key) || !value.includes("=")) {
        throw new Error(
          "Cognia model customization cannot override provider, credentials or runtime configuration"
        )
      }
      // A value must be one scalar assignment, not a second TOML document
      // smuggled after a newline or an inline object with provider settings.
      let valid = false
      try {
        const parsed = parseToml(value)
        valid = Object.keys(parsed).length === 1 && typeof parsed[key] === "string"
      } catch {
        // Invalid TOML is a launch configuration error, never raw output.
      }
      if (!valid) throw new Error("Invalid Cognia model customization configuration value")
      args.push(token)
      if (separator < 0) args.push(value)
      continue
    }
    if (grammar.switches.includes(flag) && separator < 0) {
      args.push(token)
      continue
    }
    if (grammar.values.includes(flag)) {
      const value = separator < 0 ? configured[++i] : token.slice(separator + 1)
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new Error(`Cognia model customization argument ${flag} requires a value`)
      }
      args.push(token)
      if (separator < 0) args.push(value)
      continue
    }
    // Do not echo arbitrary values: a rejected argument may contain a secret.
    throw new Error(
      "Unsupported Cognia model customization argument; use the Agent's own model route for unrestricted launch options"
    )
  }
  if (prefixIndex !== required.length) {
    throw new Error(
      "Cognia model customization must retain the runtime's protocol launch arguments"
    )
  }
  return { command, args }
}

function codexCustomization(config: ExternalAgentConfig): Record<string, string> {
  const raw = config.process?.env?.CODEX_CONFIG
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Invalid Cognia model customization CODEX_CONFIG")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid Cognia model customization CODEX_CONFIG")
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (CODEX_CUSTOM_CONFIG_KEYS.has(key) && typeof value === "string") result[key] = value
    else if (
      [
        "model",
        "review_model",
        "model_provider",
        "model_providers",
        "model_context_window",
        "model_auto_compact_token_limit",
      ].includes(key)
    )
      continue
    else throw new Error("Unsupported Cognia model customization CODEX_CONFIG field")
  }
  return result
}

// Per-runtime environment outside the shared route-owned list. `preserved`
// keys and prefixes are user customization that cannot select a provider,
// model, credential or endpoint; `routeOwned` ones are replaced by the task's
// route (or its task-owned home), so dropping them is deliberate. Anything
// else is refused rather than guessed at.
const RUNTIME_ENVIRONMENT: Record<
  string,
  {
    preserved?: readonly string[]
    preservedPrefixes?: readonly string[]
    routeOwned?: readonly string[]
    routeOwnedPrefixes?: readonly string[]
  }
> = {
  codex: { preserved: ["CODEX_PATH", "NO_BROWSER", "INITIAL_AGENT_MODE", "APP_SERVER_LOGS"] },
  dsh: { routeOwned: ["DSH_HOME"], routeOwnedPrefixes: ["COGNIA_DSH_"] },
  // Kimi Code 2.1: KIMI_MODEL_* is the env-model provider, KIMI_API_KEY /
  // KIMI_BASE_URL / KIMI_CODE_BASE_URL its managed platform route, the OAuth
  // hosts its login, and KIMI_SECONDARY_* a second model for side work.
  kimi: {
    preserved: ["KIMI_CODE_NO_AUTO_UPDATE", "KIMI_CLI_NO_AUTO_UPDATE", "KIMI_DISABLE_TELEMETRY"],
    preservedPrefixes: ["KIMI_MCP_", "KIMI_LOOP_"],
    routeOwned: [
      "KIMI_API_KEY",
      "KIMI_BASE_URL",
      "KIMI_CODE_BASE_URL",
      "KIMI_CODE_CUSTOM_HEADERS",
      "KIMI_CODE_HOME",
      "KIMI_SHARE_DIR",
      "KIMI_OAUTH_HOST",
      "KIMI_CODE_OAUTH_HOST",
    ],
    routeOwnedPrefixes: ["KIMI_MODEL_", "KIMI_SECONDARY_"],
  },
  // Goose reads every config key from its upper-cased environment name, so a
  // lead/planner/subagent provider or another OpenAI host would be a second
  // route; keyring and telemetry switches are pinned by the task.
  goose: {
    preserved: [
      "GOOSE_MODE",
      "GOOSE_TEMPERATURE",
      "GOOSE_SHELL",
      "GOOSE_STREAM_TIMEOUT",
      "GOOSE_SUBAGENT_MAX_TURNS",
      "GOOSE_CLI_MIN_PRIORITY",
    ],
    routeOwned: [
      "GOOSE_PROVIDER",
      "GOOSE_MODEL",
      "GOOSE_CONTEXT_LIMIT",
      "GOOSE_INPUT_LIMIT",
      "GOOSE_DISABLE_KEYRING",
      "GOOSE_TELEMETRY_OFF",
      "GOOSE_TELEMETRY_ENABLED",
      "GOOSE_TOOLSHIM",
      "GOOSE_TOOLSHIM_OLLAMA_MODEL",
      "GOOSE_CLIENT_CERT_PATH",
      "GOOSE_CLIENT_KEY_PATH",
    ],
    routeOwnedPrefixes: [
      "GOOSE_LEAD_",
      "GOOSE_PLANNER_",
      "GOOSE_SUBAGENT_PROVIDER",
      "GOOSE_SUBAGENT_MODEL",
      "OPENAI_",
    ],
  },
  // Copilot CLI 1.0: COPILOT_PROVIDER_* is BYOK, the GitHub tokens and hosts
  // are its native account route.
  copilot: {
    preserved: [
      "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
      "PLAIN_DIFF",
      "USE_BUILTIN_RIPGREP",
      "USE_TGREP",
    ],
    routeOwned: [
      "COPILOT_MODEL",
      "COPILOT_OFFLINE",
      "COPILOT_AUTO_UPDATE",
      "COPILOT_AUTO_TIER",
      "COPILOT_HOME",
      "COPILOT_CACHE_HOME",
      "COPILOT_PKG_CACHE_HOME",
      "COPILOT_CLI_VERSION",
      "COPILOT_CLI_DIST_DIR",
      "COPILOT_GITHUB_TOKEN",
      "COPILOT_GH_HOST",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_HOST",
    ],
    routeOwnedPrefixes: ["COPILOT_PROVIDER_"],
  },
  aider: {
    preserved: [
      "AIDER_EDIT_FORMAT",
      "AIDER_EDITOR_EDIT_FORMAT",
      "AIDER_REASONING_EFFORT",
      "AIDER_THINKING_TOKENS",
    ],
    routeOwned: ["AIDER_MODEL", "AIDER_WEAK_MODEL", "AIDER_EDITOR_MODEL", "OPENAI_API_BASE"],
  },
}

function customizationEnvironment(
  config: ExternalAgentConfig,
  runtime: string
): Record<string, string> {
  const preserved = new Set(["LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "NO_COLOR", "FORCE_COLOR"])
  const rules = RUNTIME_ENVIRONMENT[runtime] ?? {}
  for (const key of rules.preserved ?? []) preserved.add(key)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.process?.env ?? {})) {
    if (preserved.has(key) || rules.preservedPrefixes?.some((prefix) => key.startsWith(prefix)))
      env[key] = value
    // These values belong to the selected route or the task-owned home. Their
    // replacement is deliberate, unlike silently throwing away custom flags.
    else if (
      [
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_MODEL",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_BASE_URL",
        "CODEX_API_KEY",
        "CODEX_ACCESS_TOKEN",
        "CODEX_HOME",
        "CODEX_CONFIG",
        "MODEL_PROVIDER",
        "DEFAULT_AUTH_REQUEST",
        "OPENCODE_CONFIG",
        "OPENCODE_CONFIG_CONTENT",
        "OPENCODE_CONFIG_DIR",
        "QWEN_HOME",
        "QWEN_API_KEY",
        "PI_CODING_AGENT_DIR",
        "PI_CODING_AGENT_SESSION_DIR",
        "HOME",
        "USERPROFILE",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "COGNIA_GATEWAY_TASK_CONFIG",
        "COGNIA_GATEWAY_TOKEN",
        "COGNIA_TOOLHOST_SOCKET",
        "COGNIA_TOOLHOST_TOKEN",
        "COGNIA_TOOLHOST_SERVER",
        ...(rules.routeOwned ?? []),
      ].includes(key) ||
      rules.routeOwnedPrefixes?.some((prefix) => key.startsWith(prefix))
    )
      continue
    else throw new Error(`Unsupported Cognia model environment customization: ${key}`)
  }
  return env
}

const openCodeAction = z.enum(["allow", "deny", "ask"])
const openCodePermission = z.union([
  openCodeAction,
  z.record(z.string(), z.union([openCodeAction, z.record(z.string(), openCodeAction)])),
])
const openCodePermissions = z
  .array(
    z
      .object({
        action: z.string(),
        resource: z.string(),
        effect: openCodeAction,
      })
      .strict()
  )
  .max(256)
const openCodeAgentFields = {
  model: z.string().optional(),
  description: z.string().optional(),
  mode: z.enum(["primary", "subagent", "all"]).optional(),
  hidden: z.boolean().optional(),
  color: z
    .string()
    .regex(/^(#[0-9a-fA-F]{6}|primary|secondary|accent|success|warning|error|info)$/)
    .optional(),
  steps: z.number().int().positive().optional(),
}
const openCodeCommand = z
  .object({
    template: z.string(),
    description: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    subtask: z.boolean().optional(),
  })
  .strict()
const openCodeCommon = {
  default_agent: z.string().min(1).optional(),
  instructions: z.array(z.string().min(1)).max(128).optional(),
}
const openCodeV1Customization = z
  .object({
    ...openCodeCommon,
    agent: z
      .record(
        z.string(),
        z
          .object({
            ...openCodeAgentFields,
            prompt: z.string().optional(),
            temperature: z.number().finite().optional(),
            top_p: z.number().finite().optional(),
            disable: z.boolean().optional(),
            tools: z.record(z.string(), z.boolean()).optional(),
            permission: openCodePermission.optional(),
          })
          .strict()
      )
      .optional(),
    command: z.record(z.string(), openCodeCommand).optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    permission: openCodePermission.optional(),
    skills: z
      .object({ paths: z.array(z.string()).optional(), urls: z.array(z.string()).optional() })
      .strict()
      .optional(),
    snapshot: z.boolean().optional(),
  })
  .strict()
const openCodeV2Customization = z
  .object({
    ...openCodeCommon,
    agents: z
      .record(
        z.string(),
        z
          .object({
            ...openCodeAgentFields,
            system: z.string().optional(),
            disabled: z.boolean().optional(),
            permissions: openCodePermissions.optional(),
          })
          .strict()
      )
      .optional(),
    commands: z.record(z.string(), openCodeCommand).optional(),
    permissions: openCodePermissions.optional(),
    skills: z.array(z.string()).max(128).optional(),
    snapshots: z.boolean().optional(),
  })
  .strict()

/** Explicit inline customization is separate from task-owned provider routing. */
function openCodeCustomization(
  config: ExternalAgentConfig,
  selectedModel: string
): Record<string, unknown> {
  const source = config.process?.env
  if (source?.OPENCODE_CONFIG || source?.OPENCODE_CONFIG_DIR)
    throw new Error(
      "Cognia model customization requires inline OpenCode settings instead of an external configuration path"
    )
  const raw = source?.OPENCODE_CONFIG_CONTENT
  if (!raw) return {}
  const invalid = () => new Error("Invalid or unsupported Cognia model OpenCode customization")
  let input: Record<string, unknown>
  try {
    if (raw.length > 65_536) throw invalid()
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid()
    input = { ...parsed }
  } catch {
    throw invalid()
  }
  for (const key of [
    "$schema",
    "model",
    "small_model",
    "provider",
    "providers",
    "enabled_providers",
    "disabled_providers",
  ])
    delete input[key]
  const v2 = config.protocol === "opencode-v2"
  const result = (v2 ? openCodeV2Customization : openCodeV1Customization).safeParse(input)
  if (!result.success) throw invalid()
  const output: Record<string, unknown> = { ...result.data }
  // Custom agents and slash commands may otherwise select a different provider.
  for (const key of v2 ? ["agents", "commands"] : ["agent", "command"]) {
    const entries = output[key] as Record<string, Record<string, unknown>> | undefined
    if (entries)
      output[key] = Object.fromEntries(
        Object.entries(entries).map(([name, entry]) => [name, { ...entry, model: selectedModel }])
      )
  }
  return output
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
  /** The paired device that owns a Host-run task (see {@link GatewayTaskPayload}). */
  originDeviceId?: string | null
  /** Move an existing task to this binding (see {@link GatewayTaskPayload}). */
  rebind?: boolean
}): {
  config: ExternalAgentConfig
  /**
   * The value the child session must report as its selected model, or
   * `undefined` when the runtime has no session model surface on this route
   * and the launch alone selects the model (Copilot BYOK).
   */
  model: string | undefined
} {
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
  const launch = customizedGatewayLaunch(config, runtime)
  const files: Record<string, string> = {}
  // Deliberately rebuild this map: user/provider credentials and runtime config
  // overrides must never compete with a task's gateway route.
  const env: Record<string, string> = {
    ...customizationEnvironment(config, runtime),
    [GATEWAY_TOKEN_ENV]: secret,
  }
  for (const key of ["COGNIA_TOOLHOST_SOCKET", "COGNIA_TOOLHOST_TOKEN", "COGNIA_TOOLHOST_SERVER"]) {
    const value = config.process?.env?.[key]
    if (value) env[key] = value
  }
  let selectedModel: string | undefined = model
  const launchArgs: string[] = []
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
    const custom = codexCustomization(config)
    files["codex/config.toml"] =
      [
        ...Object.entries(custom).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
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
        ...custom,
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
    const custom = openCodeCustomization(config, selectedModel)
    const limit = {
      ...(meta.contextLength ? { context: meta.contextLength } : {}),
      ...(meta.maxInputTokens ? { input: meta.maxInputTokens } : {}),
      ...(meta.maxOutputTokens ? { output: meta.maxOutputTokens } : {}),
    }
    // The bundled ACP executable is OpenCode V1; V2 provider declarations are
    // explicitly unsupported by its compatibility reader (v1.18.32).
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(
      config.protocol !== "opencode-v2"
        ? {
            ...custom,
            model: selectedModel,
            small_model: selectedModel,
            enabled_providers: ["cognia"],
            provider: {
              cognia: {
                name: "Cognia",
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: endpoint, apiKey: `{env:${GATEWAY_TOKEN_ENV}}` },
                models: {
                  [model]: {
                    name: model,
                    // V1 requires both values when a limit object is present.
                    ...(meta.contextLength && meta.maxOutputTokens ? { limit } : {}),
                    tool_call: true,
                    reasoning: meta.supportsReasoning === true,
                    modalities: {
                      input: meta.supportsVision ? ["text", "image"] : ["text"],
                      output: ["text"],
                    },
                  },
                },
              },
            },
          }
        : {
            ...custom,
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
                    ...(Object.keys(limit).length ? { limit } : {}),
                    capabilities: {
                      tools: true,
                      input: meta.supportsVision ? ["text", "image"] : ["text"],
                      output: ["text"],
                    },
                  },
                },
              },
            },
          }
    )
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
  } else if (runtime === "kimi") {
    // Kimi Code's env-model provider (2.1.1 `applyEnvModelConfig`): an
    // OpenAI-compatible provider type speaks Chat Completions, the alias it
    // registers is the fixed `__kimi_env_model__`, and the key stays in this
    // process environment (stripped again before any config write).
    selectedModel = "__kimi_env_model__"
    env.KIMI_MODEL_PROVIDER_TYPE = "openai"
    env.KIMI_MODEL_BASE_URL = endpoint
    env.KIMI_MODEL_API_KEY = secret
    env.KIMI_MODEL_NAME = model
    env.KIMI_MODEL_DISPLAY_NAME = model
    const context = meta.contextLength
      ? Math.min(meta.contextLength, meta.maxInputTokens ?? meta.contextLength)
      : undefined
    if (context) env.KIMI_MODEL_MAX_CONTEXT_SIZE = String(context)
    if (meta.maxOutputTokens) env.KIMI_MODEL_MAX_OUTPUT_SIZE = String(meta.maxOutputTokens)
    // Without an explicit list Kimi assumes image input and thinking.
    env.KIMI_MODEL_CAPABILITIES = [
      "tool_use",
      ...(meta.supportsReasoning === true ? ["thinking"] : []),
      ...(meta.supportsVision === true ? ["image_in"] : []),
      ...(meta.supportsVideo === true ? ["video_in"] : []),
      ...(meta.supportsAudio === true ? ["audio_in"] : []),
    ].join(",")
    env.KIMI_CODE_NO_AUTO_UPDATE = "1"
    env.KIMI_DISABLE_TELEMETRY = "1"
  } else if (runtime === "goose") {
    // Goose reads provider settings from the environment before its config
    // file. The keyring stays closed so another provider's stored secret is
    // never reachable from the task; the session model option reports the
    // plain model id.
    const url = new URL(endpoint)
    env.GOOSE_PROVIDER = "openai"
    env.GOOSE_MODEL = model
    env.OPENAI_HOST = url.origin
    env.OPENAI_BASE_PATH = [url.pathname.replace(/^\/+|\/+$/g, ""), "chat/completions"]
      .filter(Boolean)
      .join("/")
    env.OPENAI_API_KEY = secret
    env.GOOSE_DISABLE_KEYRING = "1"
    env.GOOSE_TELEMETRY_OFF = "1"
    if (meta.contextLength)
      env.GOOSE_CONTEXT_LIMIT = String(
        Math.min(meta.contextLength, meta.maxInputTokens ?? meta.contextLength)
      )
  } else if (runtime === "copilot") {
    // Copilot CLI BYOK. It exposes no session model option on this route and a
    // resumed session keeps its recorded model unless `--model` is passed, so
    // the launch carries the model. The GitHub tokens are deliberate
    // placeholders: they outrank any stored Copilot login, so a build without
    // BYOK fails authentication instead of silently using GitHub's route.
    selectedModel = undefined
    env.COPILOT_PROVIDER_BASE_URL = endpoint
    env.COPILOT_PROVIDER_TYPE = "openai"
    env.COPILOT_PROVIDER_WIRE_API = "completions"
    env.COPILOT_PROVIDER_API_KEY = secret
    env.COPILOT_MODEL = model
    if (meta.maxInputTokens || meta.contextLength)
      env.COPILOT_PROVIDER_MAX_PROMPT_TOKENS = String(meta.maxInputTokens ?? meta.contextLength)
    if (meta.maxOutputTokens) env.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS = String(meta.maxOutputTokens)
    env.COPILOT_OFFLINE = "true"
    env.COPILOT_AUTO_UPDATE = "false"
    for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"])
      env[key] = COPILOT_NO_GITHUB_AUTH
    launchArgs.push("--model", model)
  } else if (runtime === "aider") {
    // LiteLLM's OpenAI-compatible route: `openai/<model>` against the given
    // API base, key from OPENAI_API_KEY. Weak and editor models default to
    // provider-specific models, so they are pinned to the task model too.
    selectedModel = `openai/${model}`
    env.OPENAI_API_KEY = secret
    launchArgs.push(
      "--model",
      selectedModel,
      "--weak-model",
      selectedModel,
      "--editor-model",
      selectedModel,
      "--openai-api-base",
      endpoint
    )
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
    ...(input.originDeviceId ? { originDeviceId: input.originDeviceId } : {}),
    ...(input.rebind ? { rebind: true as const } : {}),
    files,
  } satisfies GatewayTaskPayload)
  const args = [...launch.args, ...launchArgs]
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
        command: launch.command,
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
