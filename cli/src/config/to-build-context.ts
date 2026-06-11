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
import { getBuiltInProviderDefaultBaseURL } from "@/types/provider/built-in-provider-catalog"
import type { BuildOptionsContext } from "@/lib/claude/build-options"
import type { AppSettings, Character, ChatSession, McpServer } from "@/lib/claude/types"

import { resolveActiveModel } from "./active-model"
import { RESOLVER_PROTOCOLS, type ResolvedConfig } from "./schema"

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
  /** Injected clock for deterministic tests; defaults to `Date.now()`. */
  now?: number
}

const BUILTIN_PROTOCOLS = new Set<string>(RESOLVER_PROTOCOLS)

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
    }
  }
  return out
}

/**
 * Self-hosted / custom providers — any entry carrying an explicit `protocol`.
 * Built-in ids (anthropic/openai/…) derive their protocol downstream and need
 * no custom def.
 */
function buildCustomProviders(config: ResolvedConfig): AppSettings["customProviders"] {
  const customs = Object.entries(config.providers)
    .filter(([id, p]) => p.protocol && !BUILTIN_PROTOCOLS.has(id))
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
  now: number
): ChatSession {
  return {
    id: sessionId,
    title: "cli",
    kind: "direct",
    model: resolveActiveModel(config),
    providerOverride: config.provider,
    systemPrompt: config.systemPrompt,
    workingDir: config.cwd,
    permissionMode: config.permissionMode,
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
    defaultSystemPrompt: config.systemPrompt,
    permissionMode: config.permissionMode,
    builtinTools: config.builtinTools,
    providerSettings: buildProviderSettings(config),
    customProviders: buildCustomProviders(config),
  } as unknown as AppSettings

  const session = buildCliSession(sessionId, config, now)

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
    agentMode: null,
    preloadedMcpServers: params.mcpServers ?? [],
    ...(params.ephemeralSkillIds?.length ? { ephemeralSkillIds: params.ephemeralSkillIds } : {}),
    preloadedEnv: buildPreloadedEnv(config),
  }
}
