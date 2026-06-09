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
import type { BuildOptionsContext } from "@/lib/claude/build-options"
import type { AppSettings, Character, ChatSession } from "@/lib/claude/types"

import { RESOLVER_PROTOCOLS, type ResolvedConfig } from "./schema"

export interface ToBuildContextParams {
  /** Stable session id for this run (also used by handoff). */
  sessionId: string
  config: ResolvedConfig
  /** Injected clock for deterministic tests; defaults to `Date.now()`. */
  now?: number
}

const BUILTIN_PROTOCOLS = new Set<string>(RESOLVER_PROTOCOLS)

/** Build the `providerSettings` map the credential resolver reads. */
function buildProviderSettings(config: ResolvedConfig): Record<string, ProviderSettingsEntry> {
  const out: Record<string, ProviderSettingsEntry> = {}
  for (const [id, p] of Object.entries(config.providers)) {
    out[id] = {
      enabled: true,
      ...(p.apiKey ? { apiKey: p.apiKey } : {}),
      ...(p.baseURL ? { baseURL: p.baseURL } : {}),
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
  return customs.length ? (customs as AppSettings["customProviders"]) : undefined
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
  if (p?.apiKey) env.ANTHROPIC_API_KEY = p.apiKey
  if (p?.baseURL) env.ANTHROPIC_BASE_URL = p.baseURL
  return env
}

/**
 * Translate a resolved CLI config into the desktop's `BuildOptionsContext`.
 * The returned ctx is fed verbatim to `resolveSendOptions`.
 */
export function toBuildContext(params: ToBuildContextParams): BuildOptionsContext {
  const { sessionId, config } = params
  const now = params.now ?? Date.now()

  const appSettings = {
    defaultProvider: config.provider,
    defaultModel: config.model,
    defaultSystemPrompt: config.systemPrompt,
    permissionMode: config.permissionMode,
    builtinTools: config.builtinTools,
    providerSettings: buildProviderSettings(config),
    customProviders: buildCustomProviders(config),
  } as unknown as AppSettings

  const session = {
    id: sessionId,
    title: "cli",
    kind: "direct",
    model: config.model,
    providerOverride: config.provider,
    systemPrompt: config.systemPrompt,
    workingDir: config.cwd,
    permissionMode: config.permissionMode,
    createdAt: now,
    updatedAt: now,
  } as ChatSession

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
    preloadedMcpServers: [],
    preloadedEnv: buildPreloadedEnv(config),
  }
}
