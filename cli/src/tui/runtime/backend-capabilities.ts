/**
 * What the ACTIVE agent backend can actually do.
 *
 * The TUI grew up around the built-in sidecar, so every command, settings row
 * and footer segment silently assumed the whole feature set was reachable.
 * Hosting Codex or Claude Code breaks that assumption in a way the user cannot
 * see: `/compact` posts a control message to a sidecar that was never spawned,
 * `/limits` waits on an event channel nothing feeds, and a `/thinking` switch
 * changes a value that is never forwarded. Rather than scatter
 * `if (backend !== "builtin")` across a dozen call sites, every surface reads
 * one capability set — so an unsupported feature can be shown as unavailable
 * WITH a reason instead of failing silently.
 *
 * A capability has two sources, merged here:
 *   - the preset's static declaration (a protocol either has a slot for the
 *     feature or it does not), and
 *   - what the agent negotiated during `initialize` (an ACP agent advertises
 *     MCP and session-load support per implementation).
 *
 * Pure — the caller supplies the negotiated half.
 */
import type { AcpCapabilities } from "@/types/agent/external-agent"

/**
 * Is this backend id the built-in sidecar?
 *
 * Lives here rather than beside the connect orchestration because the reducer,
 * the footer and the identity line all need it on every render — and importing
 * it from the controller would drag the whole external-agent protocol stack
 * (manager + ACP client, ~200KB) into their module graphs for a one-line check.
 */
export function isBuiltinBackend(backend: string | undefined): boolean {
  return !backend || backend === "builtin"
}

/** A TUI feature whose availability depends on the active backend. */
export type BackendFeature =
  | "mcp"
  | "thinking"
  | "skills"
  | "plugins"
  | "compact"
  | "resume"
  | "rateLimits"
  | "mcpLogs"
  | "hooks"
  | "subagentModels"

export const BACKEND_FEATURES: readonly BackendFeature[] = [
  "mcp",
  "thinking",
  "skills",
  "plugins",
  "compact",
  "resume",
  "rateLimits",
  "mcpLogs",
  "hooks",
  "subagentModels",
]

/** Human labels, used by `/settings`, the command palette and `/status`. */
export const BACKEND_FEATURE_LABELS: Record<BackendFeature, string> = {
  mcp: "MCP servers",
  thinking: "Thinking level",
  skills: "Skills",
  plugins: "Plugin tools",
  compact: "Context compaction",
  resume: "Session resume",
  rateLimits: "Rate limits",
  mcpLogs: "MCP logs",
  hooks: "Lifecycle hooks",
  subagentModels: "Subagent models",
}

export interface FeatureSupport {
  supported: boolean
  /** Why not — shown next to the greyed-out row. Absent when supported. */
  reason?: string
}

export interface BackendCapabilities {
  /** The backend these describe (`builtin` or an external preset id). */
  backend: string
  /** The preset actually launched, when it differs from the requested backend
   * (`codex` resolves to an executable variant). Carried here so the identity
   * line can name it from state rather than reaching into a ref during render. */
  presetId?: string
  /** True for the built-in sidecar, where everything is reachable. */
  builtin: boolean
  features: Record<BackendFeature, FeatureSupport>
}

const SUPPORTED: FeatureSupport = { supported: true }

/** Reasons, written once so every surface phrases a gap identically. */
const REASON = {
  sidecarOnly: "only the built-in agent reports this",
  notForwarded: "not forwarded to an external agent yet",
  noProtocolSlot: "the agent protocol has no equivalent",
  agentOwned: "the external agent runs these itself",
} as const

/**
 * Presets whose adapter reads the Codex metadata channel (`codexOptions`).
 *
 * That channel is the ONLY route reasoning effort and extra skill roots have, so
 * it decides both what the bridge forwards and what this module may advertise —
 * hence one definition rather than a capability table that could drift from the
 * code doing the forwarding.
 */
const CODEX_PRESETS = new Set(["codex", "codex-app-server"])

export function usesCodexOptions(presetId: string | undefined): boolean {
  return !!presetId && CODEX_PRESETS.has(presetId)
}

/** Everything the built-in sidecar supports — i.e. everything. */
export function builtinCapabilities(): BackendCapabilities {
  return {
    backend: "builtin",
    builtin: true,
    features: Object.fromEntries(BACKEND_FEATURES.map((f) => [f, SUPPORTED])) as Record<
      BackendFeature,
      FeatureSupport
    >,
  }
}

export interface ExternalCapabilityInput {
  /** The backend id the user selected (`codex`, `claude-code`, …). */
  backend: string
  /** The preset actually launched — `codex` resolves to an executable variant. */
  presetId?: string
  /** What the agent advertised during `initialize`, when the handshake got that
   * far. Absent means "not negotiated yet"; a negotiated feature then reads as
   * unsupported rather than being optimistically assumed. */
  negotiated?: AcpCapabilities
}

/**
 * Capabilities for an external backend.
 *
 * The supported entries are the ones something is genuinely forwarded for:
 * MCP servers ride `session/new` on both protocols, while reasoning effort and
 * skill roots have only the Codex metadata channel. Everything else is reported
 * unsupported WITH a reason — a capability set that described intent rather than
 * behaviour would be exactly the silent lie this module exists to prevent.
 */
export function externalCapabilities(input: ExternalCapabilityInput): BackendCapabilities {
  const codexChannel = usesCodexOptions(input.presetId ?? input.backend)
  const unsupported = (reason: string): FeatureSupport => ({ supported: false, reason })
  return {
    backend: input.backend,
    ...(input.presetId ? { presetId: input.presetId } : {}),
    builtin: false,
    features: {
      // Forwarded per turn, so a `/mcp` toggle lands on the next message.
      mcp: SUPPORTED,
      // Read when the agent is registered, so a change needs a reconnect.
      thinking: codexChannel ? SUPPORTED : unsupported(REASON.noProtocolSlot),
      skills: codexChannel ? SUPPORTED : unsupported(REASON.noProtocolSlot),
      plugins: unsupported(REASON.notForwarded),
      compact: unsupported(REASON.noProtocolSlot),
      resume: input.negotiated?.multiTurn ? SUPPORTED : unsupported(REASON.noProtocolSlot),
      rateLimits: unsupported(REASON.sidecarOnly),
      mcpLogs: unsupported(REASON.agentOwned),
      hooks: unsupported(REASON.sidecarOnly),
      subagentModels: unsupported(REASON.notForwarded),
    },
  }
}

/** Is `feature` usable right now? Unknown capabilities read as supported so a
 * missing capability set never disables the built-in path. */
export function supportsFeature(
  capabilities: BackendCapabilities | undefined,
  feature: BackendFeature
): boolean {
  return capabilities?.features[feature]?.supported ?? true
}

/** Why `feature` is unavailable, or undefined when it is available. */
export function featureBlockedReason(
  capabilities: BackendCapabilities | undefined,
  feature: BackendFeature
): string | undefined {
  const support = capabilities?.features[feature]
  return support && !support.supported ? support.reason : undefined
}

/** One-line refusal shown when an unsupported command is invoked anyway. */
export function unsupportedFeatureMessage(
  capabilities: BackendCapabilities | undefined,
  feature: BackendFeature
): string {
  const reason = featureBlockedReason(capabilities, feature)
  const label = BACKEND_FEATURE_LABELS[feature]
  const backend = capabilities?.backend ?? "this backend"
  return reason ? `${label} is unavailable on ${backend} — ${reason}.` : `${label} is unavailable.`
}

/** The unsupported features, in declaration order — for a compact summary. */
export function blockedFeatures(capabilities: BackendCapabilities | undefined): BackendFeature[] {
  if (!capabilities) return []
  return BACKEND_FEATURES.filter((feature) => !capabilities.features[feature].supported)
}
