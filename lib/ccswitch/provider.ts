// Provider identity, SDK compatibility, and Anthropic model registration.

import type { CcswitchAgentId, CcswitchProvider } from "@/types/ccswitch"
import type { AppSettings } from "@cognia/agent-config-types"
import { ANTHROPIC_FALLBACK_MODEL_ID } from "@cognia/provider-types/built-in-provider-catalog"
import type {
  ProviderModelDiscoveryEntry,
  UserProviderSettings,
} from "@cognia/provider-types/provider"

/** Destinations with an Anthropic credential path for the bundled SDK switch. */
export const CCSWITCH_PROPAGATION_AGENTS: readonly CcswitchAgentId[] = ["claude-code", "opencode"]

/** Stable id used to mark cognia-next's active CCSwitch provider. */
export function ccswitchProviderRefId(provider: CcswitchProvider): string {
  return `ccswitch:${provider.kind}:${provider.id}`
}

/** Cognia's bundled SDK speaks Anthropic; other CC Switch apps remain browseable. */
function isClaudeRelayKind(kind: string | undefined): boolean {
  return kind === "claude" || kind === "claude-desktop"
}

export function isOfficialClaudeProvider(provider: CcswitchProvider): boolean {
  return (
    isClaudeRelayKind(provider.kind) &&
    !provider.providerType &&
    !provider.apiKey?.trim() &&
    !provider.baseUrl?.trim()
  )
}

export function canSwitchProvider(provider: CcswitchProvider): boolean {
  return (
    isClaudeRelayKind(provider.kind) &&
    !provider.providerType &&
    (!!provider.apiKey?.trim() || isOfficialClaudeProvider(provider))
  )
}

/** Per-turn credentials survive a sidecar restart and override inherited OAuth. */
export function ccswitchApiKeyEnv(
  settings:
    | Pick<AppSettings, "activeProviderId" | "apiKey" | "apiBaseUrl" | "providerSettings">
    | null
    | undefined
): Record<string, string> | null {
  if (
    !/^ccswitch:claude(?:-desktop)?:/.test(settings?.activeProviderId ?? "") ||
    !settings?.apiKey?.trim()
  )
    return null
  return {
    ANTHROPIC_API_KEY: settings.apiKey.trim(),
    ANTHROPIC_BASE_URL: settings.apiBaseUrl?.trim() || "",
    ANTHROPIC_CUSTOM_HEADERS: Object.entries(
      settings.providerSettings?.anthropic?.customHeaders ?? {}
    )
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n"),
  }
}

/** Human-readable suffix per tier, appended to the provider name for the model
 *  picker so a relay's three tiers are distinguishable at a glance. */
const TIER_LABEL: Record<string, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fast: "Fast",
}

/** True when any forwarded header unlocks the 1M context window. */
function relayEnablesContext1m(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false
  return Object.values(headers).some((v) => v.toLowerCase().includes("context-1m"))
}

export interface ProviderRegistration {
  /** The merged `providerSettings` map to persist (anthropic slot updated). */
  providerSettings: Record<string, UserProviderSettings>
  defaultProvider: string
  defaultModel: string
  /** Headers to forward to the sidecar (may be empty → clears prior relay's). */
  customHeaders: Record<string, string>
}

/**
 * Turn a Claude-relay CCSwitch provider into a cognia provider registration:
 * surface the relay's opus/sonnet/haiku (+ small-fast + primary) models under
 * the built-in `anthropic` provider (the native-dispatch path a relay rides on
 * — see `lib/claude/build-options.ts`), backfill the key, and point the app
 * default at the primary model. 1M-capable relays stamp a 1M context window on
 * every tier so the picker + context indicator size them correctly.
 *
 * Returns `null` for a non-Claude kind. A provider without model overrides uses
 * the current built-in default while still replacing its credentials and URL.
 * Pure: the caller supplies the current `providerSettings` and persists.
 */
export function buildProviderRegistration(
  provider: CcswitchProvider,
  current: { providerSettings?: Record<string, UserProviderSettings> }
): ProviderRegistration | null {
  if (!isClaudeRelayKind(provider.kind)) return null

  // Collect (modelId → tier label) preserving priority order; first tier that
  // names an id wins the label, and duplicate ids collapse to one entry.
  const tiered: Array<{ id: string; tier: string }> = [
    { id: provider.opusModel, tier: "opus" },
    { id: provider.sonnetModel, tier: "sonnet" },
    { id: provider.haikuModel, tier: "haiku" },
    { id: provider.smallFastModel, tier: "fast" },
    { id: provider.model, tier: "primary" },
  ]
    .map((e) => ({ id: e.id?.trim(), tier: e.tier }))
    .filter((e): e is { id: string; tier: string } => Boolean(e.id))

  const seen = new Set<string>()
  const models = tiered.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))

  const is1m = relayEnablesContext1m(provider.customHeaders)
  const discoveredModels: ProviderModelDiscoveryEntry[] = models.map((e) => {
    const label = TIER_LABEL[e.tier]
    return {
      id: e.id,
      name: label ? `${provider.name} · ${label}` : provider.name,
      provider: "anthropic",
      contextLength: is1m ? 1_000_000 : undefined,
      supportsTools: true,
    }
  })

  // Primary model = ANTHROPIC_MODEL, else sonnet, else opus, else first known.
  const primaryModel =
    provider.model?.trim() ||
    provider.sonnetModel?.trim() ||
    provider.opusModel?.trim() ||
    models[0]?.id ||
    ANTHROPIC_FALLBACK_MODEL_ID

  const prevAnthropic = current.providerSettings?.anthropic
  const nextAnthropic: UserProviderSettings = {
    ...(prevAnthropic ?? {}),
    providerId: "anthropic",
    enabled: true,
    apiKey: provider.apiKey?.trim() || undefined,
    baseURL: provider.baseUrl?.trim() || undefined,
    customHeaders: provider.customHeaders ?? {},
    defaultModel: primaryModel,
    enabledModels: models.length ? models.map((e) => e.id) : undefined,
    discoveredModels,
    discoveredModelsLastFetched: Date.now(),
  }

  return {
    providerSettings: {
      ...(current.providerSettings ?? {}),
      anthropic: nextAnthropic,
    },
    defaultProvider: "anthropic",
    defaultModel: primaryModel,
    customHeaders: provider.customHeaders ?? {},
  }
}
