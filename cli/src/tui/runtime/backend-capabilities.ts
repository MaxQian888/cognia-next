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
 * {@link BackendFeature} stays: it is this TUI's display vocabulary, and it does
 * not map one-to-one onto capability ids (`skills` and `plugins` describe
 * Cognia's tool host, not anything the agent supports). What changed is where
 * the ANSWERS come from. This module used to decide them from its own reading
 * of the preset — a third table alongside the CLI's `PROTOCOL_CAPABILITIES`
 * and the renderer's `RUNTIME_CAPABILITIES.external` — and it got several
 * wrong: it reported `mcp` supported for every external backend including the
 * ones with no per-session MCP channel at all, and `hooks` unsupported with
 * "only the built-in agent reports this" when the real reason is that the CLI
 * (unlike the renderer) does not wrap external turns in the hook runtime.
 *
 * Now every row is a PROJECTION of the external capability profile (ADR-0090
 * external SSOT) plus the tool host's real state. Pure — the caller supplies
 * the negotiated half and the tool-host half.
 */
import type {
  AcpCapabilities,
  AcpPermissionMode,
  ExternalAgentProtocol,
} from "@/types/agent/external-agent"
import {
  isCapabilityUsable,
  type ExternalAgentCapabilityId,
  type ExternalAgentCapabilityProfileV1,
} from "@cognia/agent-config-types/external-agent-capability"
import { negotiateCapabilityProfile } from "@/lib/ai/agent/external/capability-profile"
import { liveCapabilityFacts } from "@/lib/ai/agent/external/capability-live-facts"
import { getPresetConfig } from "@/lib/ai/agent/external/presets"
// Pure mode arithmetic (a protocol→supported-modes table plus a permissiveness
// rank), NOT the protocol stack this module otherwise keeps out of its graph:
// `permission-modes` → `permission-cascade` → `sandbox/policy-bridge` are three
// dependency-free modules. Duplicating the table here would be the drift the
// single-source comment on `PROTOCOL_PERMISSION_MODE_SUPPORT` warns about.
import { adaptPermissionMode } from "@/lib/ai/agent/external/permission-modes"

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
  | "modelPicker"

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
  "modelPicker",
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
  modelPicker: "Model selection",
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
  /** The wire protocol the launched agent speaks. Carried on state because it
   * decides which permission modes the backend can actually ENFORCE, and the
   * footer has to answer that on every render without importing the manager. */
  protocol?: ExternalAgentProtocol
  /** True for the built-in sidecar, where everything is reachable. */
  builtin: boolean
  features: Record<BackendFeature, FeatureSupport>
}

/**
 * The mode the ACTIVE backend will really run under, given the one the user
 * picked.
 *
 * The built-in sidecar honours every mode, so it is always the identity. An
 * external backend can only enforce what its protocol models — `a2a` / `http` /
 * `websocket` are fire-and-forget transports with no client-side approval loop,
 * so a `bypassPermissions` pick there is clamped down to `default` by the
 * manager before the agent ever sees it. Surfacing the clamp is the point: a
 * footer that keeps reading `bypassPermissions` while the agent runs under
 * `default` is the same silent lie the capability model exists to prevent.
 *
 * `auto` is Cognia-only (it has no ACP rung) and normalizes to `default`, which
 * is exactly what the external session sends.
 */
export function effectivePermissionMode(
  capabilities: BackendCapabilities | undefined,
  requested: AcpPermissionMode | "auto"
): AcpPermissionMode {
  const normalized: AcpPermissionMode = requested === "auto" ? "default" : requested
  // No capabilities yet (still connecting) or the built-in agent: nothing clamps.
  if (!capabilities || capabilities.builtin || !capabilities.protocol) return normalized
  return adaptPermissionMode(normalized, capabilities.protocol).mode
}

const SUPPORTED: FeatureSupport = { supported: true }

/**
 * English wording for the profile's `reasonKey` vocabulary.
 *
 * The profile carries KEYS, not sentences, because the desktop panel renders
 * the same verdicts through next-intl. This TUI is English-only, so it owns the
 * English half — and both surfaces are explaining the same cell rather than
 * inventing their own account of why a row is grey.
 */
const REASON = {
  sidecarOnly: "only the built-in agent reports this",
  noProtocolSlot: "the agent protocol has no equivalent",
  agentOwned: "the external agent runs these itself",
  noToolHost: "this agent cannot attach Cognia's tool bridge",
  noManifest: "the current policy resolved no tools of this kind",
  restartRequired: "changing this restarts the agent's context",
  noHookRuntime: "the CLI does not run Cognia's hooks around an external turn",
  noSandbox: "this platform cannot run the mandatory sandbox",
  noSubagentDispatch: "the dispatch_agent tool was not projected",
  notNegotiated: "the agent did not advertise it during initialize",
  adapterMethodMissing: "Cognia's adapter does not implement it",
  noPerSessionMcpServers: "the agent protocol has no per-session MCP channel",
  perThreadConfigOverride: "carried as a per-thread config override",
  codexOptionsChannel: "carried on the Codex options channel",
  noMidTurnApproval: "this transport cannot carry a mid-turn approval",
  launchTimeAuthorityOnly: "authority is granted at launch and cannot change mid-run",
  committedRepliesOnly: "this channel reports committed replies only",
  cancelKillsRuntime: "cancelling ends the whole runtime, not just the turn",
  advertisedCompactCommand: "the agent advertises a /compact command",
  noAdvertisedCompactCommand: "the agent advertises no /compact command",
  nativeSummarizeRoute: "served by the provider's own summarize route",
  noManifestRow: "nothing describes this protocol's capabilities",
  cogniaHookRuntime: "Cognia's hook runtime wraps the turn",
  cogniaDispatchAgent: "served by Cognia's dispatch_agent tool",
} as const

/**
 * Turn a profile cell into a display verdict.
 *
 * `unknown` renders as unsupported, and that is the honest projection: the TUI
 * has to draw the row one way or the other, and offering a feature nobody has
 * verified is the failure mode this module exists to prevent. The reason still
 * distinguishes the two — "the agent did not advertise it" reads differently
 * from "the protocol has no equivalent".
 */
function fromProfile(
  profile: ExternalAgentCapabilityProfileV1,
  id: ExternalAgentCapabilityId
): FeatureSupport {
  const cell = profile.effective[id]
  if (isCapabilityUsable(cell.level)) return SUPPORTED
  const key = cell.reasonKey as keyof typeof REASON | undefined
  const reason =
    (key && REASON[key]) ??
    (cell.level === "unknown" ? "nothing has verified this for the running agent" : undefined)
  return reason ? { supported: false, reason } : { supported: false }
}

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

/**
 * Presets that can enumerate their own models without a session (`model/list`).
 *
 * Narrower than {@link usesCodexOptions} on purpose: only the NATIVE app-server
 * speaks that method. The `codex` preset is the `@zed-industries/codex-acp`
 * shim, and ACP has no model-list call. ACP model selection is negotiated per
 * session via `configOptions`, so ACP is handled separately below.
 */
const MODEL_LISTING_PRESETS = new Set(["codex-app-server"])

export function supportsModelListing(presetId: string | undefined): boolean {
  return !!presetId && MODEL_LISTING_PRESETS.has(presetId)
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

/**
 * What the Cognia tool host actually managed to do for this backend.
 *
 * The capability model used to answer from static backend assumptions ("plugins
 * are not forwarded", "skills are Codex-only"). Now that Cognia's tools really
 * are projected, those answers have to come from the projection: the protocol
 * has to accept an MCP server, the host has to start, and the effective policy
 * has to have produced at least one tool. Anything less and the feature is
 * genuinely unavailable — saying otherwise is the same silent lie in a new place.
 */
export interface ToolHostStatus {
  /** The protocol can carry an MCP server at `session/new`. */
  attachable: boolean
  /** The broker started and the bridge entries were attached. */
  running: boolean
  /** Effective `cognia-tools` count under the current policy. */
  builtinToolCount: number
  /** Effective `cognia-plugin-tools` count under the current policy. */
  hostToolCount: number
  /** True when `dispatch_agent` is among the projected host tools. */
  subagentDispatch: boolean
}

export interface ExternalCapabilityInput {
  /** The backend id the user selected (`codex`, `claude-code`, …). */
  backend: string
  /** The preset actually launched — `codex` resolves to an executable variant. */
  presetId?: string
  /** The launched agent config's wire protocol, when known. */
  protocol?: ExternalAgentProtocol
  /** What the agent advertised during `initialize`, when the handshake got that
   * far. Absent means "not negotiated yet"; a negotiated feature then reads as
   * unsupported rather than being optimistically assumed. */
  negotiated?: AcpCapabilities
  /** The Cognia tool host's real state. Absent ⇒ not started yet. */
  toolHost?: ToolHostStatus
}

/**
 * Can this backend host Cognia's tools at all?
 *
 * Under the default parity contract an agent that cannot attach the bridge is
 * INCOMPATIBLE, not "ready with fewer tools" — every Cognia tool the user can
 * see in `/tools` would be uncallable. The connect flow uses this to fail before
 * the composer opens rather than after the first tool call.
 */
export function canHostCogniaTools(negotiated: AcpCapabilities | undefined): boolean {
  // Absent capabilities mean the handshake never reported them; ACP agents that
  // accept `session/new` MCP servers advertise `mcpTools`. Treat an explicit
  // `false` as a refusal and an omission as "assume the protocol slot exists",
  // which is what every shipped preset does.
  return negotiated?.mcpTools !== false
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
  const unsupported = (reason: string): FeatureSupport => ({ supported: false, reason })
  const host = input.toolHost
  const attachable = host ? host.attachable : canHostCogniaTools(input.negotiated)
  const toolHostRunning = attachable && (host ? host.running : true)

  const presetId = input.presetId ?? input.backend
  const profile = negotiateCapabilityProfile({
    // A caller that already launched the agent knows its protocol; one that is
    // only describing a preset does not, and the preset registry is the static
    // answer. Falling back to the BACKEND ID (which is a preset id, never a
    // protocol) would silently produce a profile with no manifest row — every
    // capability `unknown`, every row greyed out with no explanation.
    protocol: input.protocol ?? resolvePresetProtocol(presetId) ?? presetId,
    presetId,
    hostFacts: {
      toolHostRunning,
      subagentDispatchProjected: host?.subagentDispatch ?? false,
      // The CLI's external-agent session does not wrap the turn in Cognia's
      // lifecycle hooks. The renderer does; that difference is the whole
      // reason this is a host fact rather than a protocol row, and reporting
      // it as "only the built-in agent reports this" named the wrong cause.
      hookRuntimeAvailable: false,
    },
    // The launch path already refused an unsandboxable platform before this
    // point, so a connected agent is by construction on a supported one.
    ceilings: { sandboxAvailable: true },
    // Only when a handshake actually happened. `liveCapabilityFacts` always
    // returns an object, so passing its `{}` unconditionally would stamp
    // `negotiated: true` on a profile describing a preset nobody has launched —
    // and `negotiated` is the flag the whole two-phase admission turns on
    // (`resolveExternalCapabilities` drops a projection without it, and
    // `admitNegotiatedExternalAgent` refuses one).
    ...(input.negotiated
      ? { liveFacts: liveCapabilityFacts({ negotiated: input.negotiated }) }
      : {}),
  })

  /** A Cognia-projected feature is available only when something real backs it. */
  const projected = (count: number): FeatureSupport => {
    if (!attachable) return unsupported(REASON.noToolHost)
    if (host && !host.running) return unsupported(REASON.noToolHost)
    return count > 0 ? SUPPORTED : unsupported(REASON.noManifest)
  }

  return {
    backend: input.backend,
    ...(input.presetId ? { presetId: input.presetId } : {}),
    ...(input.protocol ? { protocol: input.protocol } : {}),
    builtin: false,
    features: {
      // Was unconditionally SUPPORTED. Only ACP carries MCP servers at
      // `session/new`; Codex reaches the same outcome through a per-thread
      // config override, and OpenCode / Pi / DSH have no channel at all — so
      // `/mcp` used to offer a toggle that forwarded nothing on four of seven
      // protocols.
      mcp: fromProfile(profile, "mcp"),
      // Read when the agent is registered, so a change needs a reconnect.
      thinking: fromProfile(profile, "thinking"),
      // Skills and plugin tools are NOT agent capabilities: they ride Cognia's
      // tool host. Mapping them onto `skills.native` / `plugins.native` would
      // claim the AGENT supports them, which is a different (and false) thing.
      skills: attachable ? SUPPORTED : unsupported(REASON.noToolHost),
      plugins: projected(host?.hostToolCount ?? 0),
      compact: fromProfile(profile, "compaction"),
      resume: fromProfile(profile, "session.resume"),
      rateLimits: fromProfile(profile, "rate-limit-reporting"),
      mcpLogs: fromProfile(profile, "mcp.logs"),
      hooks: fromProfile(profile, "hooks.lifecycle"),
      // `dispatch_agent` is a host tool, so subagent models apply exactly when
      // the dispatch tool was actually projected — a bridge that never started
      // has no dispatch tool no matter what the manifest said it would carry.
      subagentModels: fromProfile(profile, "subagents.model-selection"),
      // Two different routes to the same user-visible affordance: the native
      // Codex app-server enumerates models without a session (`model/list`),
      // while ACP and Pi expose a per-session selector. Either one means the
      // picker has something to show.
      modelPicker: pickBetter(
        fromProfile(profile, "models.list"),
        fromProfile(profile, "set-model")
      ),
    },
  }
}

/**
 * The wire protocol a preset speaks, or undefined for an id no preset claims.
 *
 * Deliberately tolerant: the registry throws for a malformed id, and a lookup
 * failure here must degrade to "unknown protocol" rather than take down a
 * render.
 */
function resolvePresetProtocol(presetId: string | undefined): string | undefined {
  if (!presetId) return undefined
  try {
    return getPresetConfig(presetId)?.protocol
  } catch {
    return undefined
  }
}

/** Supported wins; otherwise keep the first reason, which is the more specific. */
function pickBetter(a: FeatureSupport, b: FeatureSupport): FeatureSupport {
  if (a.supported) return a
  if (b.supported) return b
  return a
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
