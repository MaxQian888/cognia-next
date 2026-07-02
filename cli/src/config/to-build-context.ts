/**
 * Bridge: a resolved CLI {@link ResolvedConfig} → the desktop's
 * {@link BuildOptionsContext}.
 *
 * This is the heart of "behave exactly like the desktop agent". Instead of
 * re-implementing option assembly, the CLI shapes its file/env/flag config into
 * the same `AppSettings` + `ChatSession` inputs the desktop feeds, then calls
 * the SAME `resolveSendOptions`. The only CLI-specific bits are the two
 * injected seams added to `BuildOptionsContext`:
 *   - `preloadedMcpServers: []` — no Dexie MCP lookup (v1 ships no MCP).
 *   - `preloadedEnv`           — native-Anthropic auth env, since the CLI can't
 *                                reach the desktop's Rust account/proxy resolvers.
 *
 * Provider routing mirrors the dispatch router (`sidecar/dispatch/index.mjs`):
 *   - provider "anthropic" → native claude-agent-sdk path, authed via env
 *     (ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL).
 *   - any other provider   → ai-sdk path, authed via `providerCredentials`,
 *     which `resolveSendOptions` derives from `appSettings.providerSettings`.
 * Populating both means whichever path the router picks is correctly credentialed.
 */

import type { ProviderSettingsEntry } from "@/lib/ai/provider-consumption"
import {
  getBuiltInProviderDefaultBaseURL,
  isBuiltInProviderId,
} from "@cognia/provider-types/built-in-provider-catalog"
import { generateDefaultMappings } from "@cognia/provider-routing"
import { DEFAULT_AUTO_ROUTING } from "@/types/routing/tool-route"
import type { BuildOptionsContext } from "@/lib/claude/build-options"
import type {
  AppSettings,
  Character,
  ChatSession,
  McpServer,
  SessionKind,
} from "@/lib/claude/types"
import type { AgentModeConfig } from "@/types/agent/agent-mode"

import { resolveActiveModel } from "./active-model"
import { effectivePermissionMode } from "./agent-mode"
import { buildDefaultSystemPrompt } from "./default-system-prompt"
import { composeSystemPrompt } from "./output-style"
import type { ResolvedConfig } from "./schema"
import { modelSupportsEffort, thinkingLevelToEffort } from "./thinking"

export interface ToBuildContextParams {
  /** Stable session id for this run (also used by handoff). */
  sessionId: string
  config: ResolvedConfig
  /**
   * MCP servers (from `.mcp.json`) to expose this turn. Fed verbatim to the
   * `preloadedMcpServers` build-options seam so the resolver never touches
   * Dexie. Defaults to `[]` (no MCP) when omitted.
   */
  mcpServers?: McpServer[]
  /** Skill ids to enable for this turn (resolved through `renderSkillsSection`). */
  ephemeralSkillIds?: string[]
  /**
   * Session kind. Defaults to `"direct"` (plain chat). Set to
   * `"workflow-editor"` to activate the desktop Workflow Copilot path in
   * `resolveSendOptions` — it swaps the system prompt for
   * `buildWorkflowCopilotPrompt`, scopes tools to `WORKFLOW_COPILOT_ALLOWED_TOOLS`
   * (the `wf_*` suite), and injects the live graph snapshot read from the editor
   * store registered for `sessionId`. The resolver derives the workflow id from
   * a `sessionId` shaped `workflow:<id>`.
   */
  sessionKind?: SessionKind
  /**
   * The resolved active agent mode (built-in or `.cognia/modes/*.json` custom),
   * or null/undefined for plain chat. Threaded into `BuildOptionsContext.agentMode`
   * so the SAME `resolveSendOptions` applies its system-prompt append, tool
   * allow-list, model override, and permission ruleset. Resolution is async
   * (reads disk), so the caller resolves it and passes it in. */
  agentMode?: AgentModeConfig | null
  /**
   * Marks a live, user-facing TUI turn so the shared `resolveSendOptions` still
   * requests token-level partial messages despite the CLI's injected
   * `preloadedEnv` / `preloadedMcpServers`. Without partials the native
   * Anthropic SDK streams nothing during a long single generation (e.g. writing
   * a large file), starving the run-and-capture idle watchdog into a spurious
   * "stream idle for 60000ms" interrupt. Only the interactive session-runner
   * sets this; one-shot (`run.ts`, idle disabled) and subagents leave it off.
   */
  interactive?: boolean
  /**
   * The outgoing prompt text, threaded to `routingContextHint.promptText` so
   * opt-in auto routing (`config.autoRoute`) can score the prompt's difficulty
   * and pick a tier alias. Only the one-shot `run` path knows the prompt up
   * front; the persistent interactive session resolves options once at session
   * start (bound to one dispatcher), so it leaves this off.
   */
  routingPromptText?: string
  /** Injected clock for deterministic tests; defaults to `Date.now()`. */
  now?: number
}

/** Build the `providerSettings` map the credential resolver reads. */
function buildProviderSettings(config: ResolvedConfig): Record<string, ProviderSettingsEntry> {
  const out: Record<string, ProviderSettingsEntry> = {}
  for (const [id, p] of Object.entries(config.providers)) {
    // Subscription providers that ride the OpenAI protocol (OpenCode Zen/Go,
    // codex-style endpoints) authenticate with the subscription token as a
    // bearer key. Anthropic is native + authed via env (CLAUDE_CODE_OAUTH_TOKEN
    // in `buildPreloadedEnv`), so we never fold its token in here.
    const bearer = id === "anthropic" ? p.apiKey : (p.apiKey ?? p.authToken)
    // Built-in openai-compat providers (deepseek, groq, opencode/opencode-go,
    // xai, togetherai, …) speak the OpenAI protocol but live at their OWN
    // gateway. Without a base URL the `@ai-sdk/openai` client defaults to
    // api.openai.com and the provider's key is rejected ("Incorrect API key").
    // The desktop persists the gateway URL when a provider is added; the CLI
    // has no such step, so backfill the catalog default whenever the user only
    // configured a key. An explicit config `baseURL` still wins. (Anthropic is
    // native + env-authed via `buildPreloadedEnv`, so its base URL is skipped
    // here.) Custom providers (explicit protocol) aren't in the catalog →
    // `undefined`, leaving their own `baseURL` untouched.
    const baseURL =
      p.baseURL ?? (id === "anthropic" ? undefined : getBuiltInProviderDefaultBaseURL(id))
    out[id] = {
      enabled: true,
      ...(bearer ? { apiKey: bearer } : {}),
      ...(baseURL ? { baseURL } : {}),
      ...(p.model ? { defaultModel: p.model } : {}),
      // Wire-protocol override for non-anthropic built-ins — mirrors the
      // desktop settings' apiProtocol selector (Part 2 of the baseURL fix).
      // Genuinely custom ids get their `protocol` via `buildCustomProviders`
      // below instead; the literal "anthropic" id always dispatches through
      // the native Claude Agent SDK subprocess regardless of this field, so
      // both are excluded here (matches `sidecar/dispatch/index.mjs`'s
      // id-based routing).
      ...(p.protocol && id !== "anthropic" && isBuiltInProviderId(id)
        ? { apiProtocol: p.protocol }
        : {}),
    }
  }
  return out
}

/**
 * Self-hosted / custom providers — any entry carrying an explicit `protocol`
 * whose id is NOT one of the catalog's built-in provider ids (deepseek, groq,
 * openrouter, … not just the literal protocol-family names). Built-in ids
 * get their protocol override folded into `providerSettings[id].apiProtocol`
 * instead (see `buildProviderSettings`), so they need no custom def here.
 */
function buildCustomProviders(config: ResolvedConfig): AppSettings["customProviders"] {
  const customs = Object.entries(config.providers)
    .filter(([id, p]) => p.protocol && !isBuiltInProviderId(id))
    .map(([id, p]) => ({
      id,
      name: id,
      protocol: p.protocol,
      ...(p.baseURL ? { baseURL: p.baseURL } : {}),
      ...(p.apiKey ? { apiKey: p.apiKey } : {}),
      ...(p.model ? { defaultModel: p.model } : {}),
    }))
  return customs.length ? (customs as unknown as AppSettings["customProviders"]) : undefined
}

/**
 * Native-Anthropic auth env. The claude-agent-sdk reads these from the spawned
 * process env; the ai-sdk path ignores them (it uses providerCredentials), so
 * this is `{}` for non-Anthropic providers.
 */
function buildPreloadedEnv(config: ResolvedConfig): Record<string, string> {
  if (config.provider !== "anthropic") return {}
  const p = config.providers.anthropic
  const env: Record<string, string> = {}
  // A subscription token authenticates the native agent SDK without a metered
  // API key (Claude Pro/Max). Prefer it when present; the API key still rides
  // along so an explicit key can override per the SDK's own precedence.
  if (p?.authToken) env.CLAUDE_CODE_OAUTH_TOKEN = p.authToken
  if (p?.apiKey) env.ANTHROPIC_API_KEY = p.apiKey
  if (p?.baseURL) env.ANTHROPIC_BASE_URL = p.baseURL
  return env
}

/**
 * Translate a resolved CLI config into the desktop's `BuildOptionsContext`.
 * The returned ctx is fed verbatim to `resolveSendOptions`.
 */
/**
 * The synthetic `ChatSession` the CLI runs with. Shared between
 * {@link toBuildContext} (in-memory, per-turn) and `cli-session-store`
 * (persisted into the CLI-local Dexie so the headless goal/judge runners that
 * read `getSession()` resolve the same row).
 */
export function buildCliSession(
  sessionId: string,
  config: ResolvedConfig,
  now: number,
  sessionKind: SessionKind = "direct",
  agentMode?: AgentModeConfig | null
): ChatSession {
  const model = resolveActiveModel(config)
  // Forward the thinking level as `effort` only when the resolved model
  // actually supports it — otherwise the SDK would reject the request. The
  // preference still persists in config so it re-applies after switching to a
  // reasoning-capable model.
  const effort =
    config.thinkingLevel && modelSupportsEffort(config.provider, model)
      ? thinkingLevelToEffort(config.thinkingLevel)
      : undefined
  // The session permission mode wins over the agent mode's inside
  // `resolveSendOptions`, so fold the mode's permission ruleset in HERE when the
  // user hasn't explicitly chosen one — otherwise selecting the built-in `plan`
  // mode would never make the agent read-only. An explicit `/mode` choice still
  // wins (see `effectivePermissionMode`).
  const permissionMode = effectivePermissionMode(config.permissionMode, agentMode ?? undefined)
  return {
    id: sessionId,
    title: "cli",
    kind: sessionKind,
    model,
    providerOverride: config.provider,
    // The active output style appends its instruction to the system prompt.
    // Fall back to the default CLI base prompt when the user hasn't set one, so
    // the model always knows its working directory and prefers `edit` over
    // `write` (see {@link buildDefaultSystemPrompt}).
    systemPrompt: composeSystemPrompt(
      config.systemPrompt ?? buildDefaultSystemPrompt({ cwd: config.cwd, now, permissionMode }),
      config.outputStyle
    ),
    workingDir: config.cwd,
    permissionMode,
    ...(effort ? { effort } : {}),
    createdAt: now,
    updatedAt: now,
  } as ChatSession
}

export function toBuildContext(params: ToBuildContextParams): BuildOptionsContext {
  const { sessionId, config } = params
  const now = params.now ?? Date.now()
  const model = resolveActiveModel(config)

  const appSettings = {
    defaultProvider: config.provider,
    defaultModel: model,
    defaultSystemPrompt: composeSystemPrompt(
      config.systemPrompt ??
        buildDefaultSystemPrompt({ cwd: config.cwd, now, permissionMode: config.permissionMode }),
      config.outputStyle
    ),
    permissionMode: config.permissionMode,
    builtinTools: config.builtinTools,
    providerSettings: buildProviderSettings(config),
    customProviders: buildCustomProviders(config),
    webTools: { enabled: config.webTools !== false },
    selfInvokeTools: {
      skill: config.skillTool === true,
      slashCommand: config.slashCommandTool === true,
    },
    // Always cache-optimize the CLI's prompt assembly: per-turn dynamic sections
    // (twin RAG chunks, memory recall) move to the END of the prompt so the
    // leading prefix stays byte-stable across turns. That lets every provider's
    // prompt cache keep hitting — Anthropic cache_control, OpenAI/DeepSeek
    // automatic prefix caching — turn after turn. Byte-identical to the legacy
    // assembly when no dynamic section is present, so it's safe to force on.
    cacheOptimizationEnabled: true,
    // Opt-in auto routing (default off ⇒ this block is skipped and the shim is
    // byte-identical to before). The interactive CLI otherwise omits
    // `modelMappings`, so alias/auto routing is dormant there; when the user
    // turns auto routing on we seed the tier ladder (fast/balanced/powerful)
    // from the enabled providers and flip `autoRouting.enabled`. The send path
    // then scores `routingContextHint.promptText` and rewrites the model to a
    // tier alias — see `resolveSendOptions` + `lib/routing/auto-tier.ts`.
    ...(config.autoRoute
      ? {
          modelMappings: generateDefaultMappings(new Set(Object.keys(config.providers))),
          autoRouting: { ...DEFAULT_AUTO_ROUTING, enabled: true },
        }
      : {}),
  } as unknown as AppSettings

  const session = buildCliSession(sessionId, config, now, params.sessionKind, params.agentMode)

  // A character shim carries the allowed-tools whitelist through the same
  // union logic the desktop uses. systemPrompt still comes from the session
  // (highest precedence), so the empty character prompt never leaks in.
  const character: Character | null = config.allowedTools?.length
    ? ({
        id: "cli",
        name: "cli",
        avatarColor: "oklch(0.7 0 0)",
        systemPrompt: "",
        allowedTools: config.allowedTools,
        createdAt: now,
        updatedAt: now,
      } as Character)
    : null

  return {
    session,
    character,
    appSettings,
    agentMode: params.agentMode ?? null,
    preloadedMcpServers: params.mcpServers ?? [],
    ...(params.ephemeralSkillIds?.length ? { ephemeralSkillIds: params.ephemeralSkillIds } : {}),
    // Name-only by default: enabled skills enter the prompt as a compact catalog,
    // their full bodies loaded on demand via `load_skill`. `full` restores the
    // legacy whole-body append. Mirrors `config.skillLoadMode`.
    skillRenderMode: config.skillLoadMode ?? "name",
    // `/add-dir` roots ride in as referenced dirs → unioned into the SDK's
    // `additionalDirectories`, so the Read tool can fetch them without prompting.
    ...(config.additionalRoots?.length
      ? { referencedPaths: config.additionalRoots.map((p) => ({ absolute: p, isDir: true })) }
      : {}),
    preloadedEnv: buildPreloadedEnv(config),
    // Live TUI turns opt into token-level partials so the idle watchdog stays
    // fed during a long single generation (see ToBuildContextParams.interactive).
    ...(params.interactive ? { interactive: true } : {}),
    // Prompt text for opt-in auto routing's difficulty scoring (one-shot `run`).
    ...(config.autoRoute && params.routingPromptText
      ? { routingContextHint: { promptText: params.routingPromptText } }
      : {}),
  }
}
