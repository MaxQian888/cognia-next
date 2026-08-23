// External-agent capability contract (ADR-0090 external SSOT).
//
// ADR-0090 gives `resolveAgentExecutionSpec()` the last word on how a turn
// executes, and `ResolvedAgentExecutionSpec` v2 carries a CLOSED capability
// vocabulary shared by three runtime families. External agents need more than
// that vocabulary can hold — a per-protocol declaration, what the handshake
// actually negotiated, which layer supplied each verdict, and a reason a UI can
// render — but widening the v2 closed set would force a `specVersion: 3`
// migration on two runtimes that have nothing to do with external agents.
//
// So this is a SEPARATELY versioned profile that sits BESIDE the spec. It is
// the authority on what an external agent can do; the spec stays the authority
// on how the turn executes, and the profile reaches it only through
// {@link projectExternalAgentCapabilitiesToSpec}, which speaks the v2
// vocabulary and nothing else.
//
// Zero runtime dependencies: this module is consumed by the renderer, the CLI,
// the headless brain and the gate, and it must stay importable from all four.

import type { AgentCapabilityId } from "./agent-execution"
import { AGENT_CAPABILITY_IDS } from "./agent-execution"

// ---- Protocol vocabulary ----------------------------------------------------

/**
 * The built-in protocols that have a REGISTERED adapter and can therefore run
 * an agent (`protocolAdapterRegistry.register(...)` in
 * `lib/ai/agent/external/manager.ts`).
 *
 * Membership is the executability test: a protocol not in this union (and not a
 * plugin protocol) cannot be selected for a new agent, because nothing would
 * answer the handshake.
 */
export type BuiltinExecutableExternalAgentProtocol =
  "acp" | "codex-app-server" | "dsh-sdk" | "pi-rpc" | "opencode" | "opencode-v2" | "a2a"

export const BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS: readonly BuiltinExecutableExternalAgentProtocol[] =
  ["acp", "codex-app-server", "dsh-sdk", "pi-rpc", "opencode", "opencode-v2", "a2a"]

/**
 * Protocols that exist in stored configs but have no adapter.
 *
 * `protocolAdapterRegistry.register("http", …)` has been commented out in the
 * manager since the module was written, so an `http` / `websocket` / `custom`
 * config has never been runnable — selecting one produces "no adapter for
 * protocol" at connect time. They stay READABLE so an old config still renders
 * (and can be migrated), and are excluded from every selector.
 */
export type LegacyExternalAgentProtocol = "http" | "websocket" | "custom"

export const LEGACY_EXTERNAL_AGENT_PROTOCOLS: readonly LegacyExternalAgentProtocol[] = [
  "http",
  "websocket",
  "custom",
]

/**
 * A plugin-contributed protocol, registered as `${pluginId}:${adapterId}`
 * (`types/plugin/plugin-external-agent-adapter.ts`). Both halves follow the
 * plugin id rules so a contributed protocol can never collide with a built-in
 * one — `acp` has no colon.
 */
export type PluginExternalAgentProtocol = `${string}:${string}`

/**
 * Plugin and adapter id syntax. Mirrors the plugin manifest's own id rule
 * (lowercase alphanumerics with `-`/`_`, must start alphanumeric), applied to
 * BOTH halves so `evil-plugin:../../x` cannot masquerade as an adapter id.
 */
const PROTOCOL_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/

export interface ParsedPluginExternalAgentProtocol {
  pluginId: string
  adapterId: string
}

/**
 * Split `${pluginId}:${adapterId}`, or `null` when the value is not a
 * well-formed plugin protocol. Exactly one colon: a three-segment value is
 * rejected rather than silently truncated.
 */
export function parsePluginExternalAgentProtocol(
  value: string
): ParsedPluginExternalAgentProtocol | null {
  const parts = value.split(":")
  if (parts.length !== 2) return null
  const [pluginId, adapterId] = parts
  if (!PROTOCOL_SEGMENT.test(pluginId) || !PROTOCOL_SEGMENT.test(adapterId)) return null
  return { pluginId, adapterId }
}

export function isPluginExternalAgentProtocol(value: string): value is PluginExternalAgentProtocol {
  return parsePluginExternalAgentProtocol(value) !== null
}

export function isBuiltinExecutableExternalAgentProtocol(
  value: string
): value is BuiltinExecutableExternalAgentProtocol {
  return (BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS as readonly string[]).includes(value)
}

export function isLegacyExternalAgentProtocol(value: string): value is LegacyExternalAgentProtocol {
  return (LEGACY_EXTERNAL_AGENT_PROTOCOLS as readonly string[]).includes(value)
}

/** Can a NEW agent be created on this protocol? Legacy protocols may only be read. */
export function isSelectableExternalAgentProtocol(value: string): boolean {
  return isBuiltinExecutableExternalAgentProtocol(value) || isPluginExternalAgentProtocol(value)
}

// ---- Capability vocabulary --------------------------------------------------

/**
 * Capability axes that exist only for external agents.
 *
 * They are deliberately NOT added to `AgentCapabilityId`: that union is the
 * closed wire vocabulary of `ResolvedAgentExecutionSpec` v2, shared with the
 * sidecar and the two built-in runtimes, and widening it would mean a spec
 * migration for a distinction only external surfaces can act on. Each of these
 * answers a question some external UI already asks and previously answered from
 * a hard-coded table.
 */
export type ExternalOnlyCapabilityId =
  /** The agent can surface its MCP servers' logs to the host. */
  | "mcp.logs"
  /** The agent REPORTS rate-limit/quota state (distinct from surviving it). */
  | "rate-limit-reporting"
  /** A per-subagent model can be chosen for this backend. */
  | "subagents.model-selection"
  /** The backend can enumerate its models without a live session. */
  | "models.list"

export const EXTERNAL_ONLY_CAPABILITY_IDS: readonly ExternalOnlyCapabilityId[] = [
  "mcp.logs",
  "rate-limit-reporting",
  "subagents.model-selection",
  "models.list",
]

export type ExternalAgentCapabilityId = AgentCapabilityId | ExternalOnlyCapabilityId

export const EXTERNAL_AGENT_CAPABILITY_IDS: readonly ExternalAgentCapabilityId[] = [
  ...AGENT_CAPABILITY_IDS,
  ...EXTERNAL_ONLY_CAPABILITY_IDS,
]

export function isExternalOnlyCapabilityId(
  id: ExternalAgentCapabilityId
): id is ExternalOnlyCapabilityId {
  return (EXTERNAL_ONLY_CAPABILITY_IDS as readonly string[]).includes(id)
}

/**
 * How well the agent supports a capability.
 *
 * The addition over {@link AgentCapabilitySupport} is `unknown`, and it is the
 * whole point of this contract. A protocol row that has never been measured,
 * an old plugin that predates capability declarations, and a handshake that has
 * not happened yet are all `unknown` — and `unknown` NEVER satisfies a hard
 * requirement. Collapsing it into `unsupported` would lose the ability to say
 * "we don't know yet, ask again after the handshake"; collapsing it into
 * `native` is how a run silently degrades.
 */
export type ExternalAgentCapabilityLevel = "native" | "equivalent" | "unsupported" | "unknown"

export const EXTERNAL_AGENT_CAPABILITY_LEVELS: readonly ExternalAgentCapabilityLevel[] = [
  "native",
  "equivalent",
  "unsupported",
  "unknown",
]

/**
 * WHERE a verdict came from, strongest first.
 *
 * Recorded per cell rather than per profile because a single profile mixes
 * levels freely: the protocol spec settles `streaming`, the live handshake
 * settles `session.resume`, and nothing at all settles `tools.parallel`.
 * Stamping one profile-wide evidence grade (`cognia-verified`) over that mix is
 * exactly the overclaim this field exists to prevent.
 */
export type ExternalAgentCapabilityEvidence =
  /** Measured against a live agent by a conformance run. */
  | "cognia-verified"
  /** The vendor certifies it for this protocol version. */
  | "vendor-certified"
  /** This session's handshake / negotiation said so. */
  | "handshake"
  /** A live probe called the method and observed the outcome. */
  | "probe"
  /** Cognia's adapter implements (or does not implement) the method. */
  | "adapter-code"
  /** The protocol specification has (or lacks) a slot for it. */
  | "protocol-spec"
  /** No evidence at all — only valid with level `unknown`. */
  | "none"

export const EXTERNAL_AGENT_CAPABILITY_EVIDENCE: readonly ExternalAgentCapabilityEvidence[] = [
  "cognia-verified",
  "vendor-certified",
  "handshake",
  "probe",
  "adapter-code",
  "protocol-spec",
  "none",
]

/**
 * One capability's verdict.
 *
 * `reasonKey` is an i18n key SUFFIX (`noProtocolSlot`, `notNegotiated`, …), not
 * a sentence: the same profile is rendered by the desktop settings panel, the
 * TUI and the CLI's JSON output, and a baked-in English string would be
 * untranslatable in two of the three. Required for everything except `native`,
 * for the same reason `AgentCapabilityEvidence.reason` is: an unexplained
 * `unsupported` is indistinguishable from an unfinished adapter.
 */
export interface ExternalAgentCapabilityCell {
  level: ExternalAgentCapabilityLevel
  evidence: ExternalAgentCapabilityEvidence
  reasonKey?: string
}

export type ExternalAgentCapabilityMatrix = Partial<
  Record<ExternalAgentCapabilityId, ExternalAgentCapabilityCell>
>

// ---- Merge layers -----------------------------------------------------------

/**
 * The merge layers, weakest first. The index IS the precedence, so a new layer
 * cannot be added without deciding where it sits.
 */
export type ExternalAgentCapabilityLayer =
  /** 1. The protocol's complete declaration (the manifest row). */
  | "protocol"
  /** 2. Preset / plugin refinement of that protocol. */
  | "refinement"
  /** 3. Which optional methods Cognia's adapter actually implements. */
  | "adapter-methods"
  /** 4. What THIS session's handshake and negotiation reported. */
  | "live"
  /** 5. Host / platform / policy ceilings. Intersect only — never widen. */
  | "ceiling"

export const EXTERNAL_AGENT_CAPABILITY_LAYERS: readonly ExternalAgentCapabilityLayer[] = [
  "protocol",
  "refinement",
  "adapter-methods",
  "live",
  "ceiling",
]

/** One layer's contribution to the merge. */
export interface ExternalAgentCapabilityLayerInput {
  layer: ExternalAgentCapabilityLayer
  cells: ExternalAgentCapabilityMatrix
}

/**
 * A layer contradicting a stronger-but-staler one.
 *
 * Recorded rather than swallowed: a handshake that reports `session.resume:
 * unsupported` against a manifest row claiming `native` means the manifest is
 * wrong for this agent version, and that is a maintenance signal, not noise.
 */
export interface ExternalAgentCapabilityDrift {
  capability: ExternalAgentCapabilityId
  declaredLevel: ExternalAgentCapabilityLevel
  observedLevel: ExternalAgentCapabilityLevel
  observedBy: ExternalAgentCapabilityLayer
}

const SUPPORTED_LEVELS: readonly ExternalAgentCapabilityLevel[] = ["native", "equivalent"]

/** Does this level satisfy a requirement? `unknown` never does. */
export function isCapabilityUsable(level: ExternalAgentCapabilityLevel): boolean {
  return SUPPORTED_LEVELS.includes(level)
}

/**
 * The stricter of two levels, for the ceiling intersection.
 *
 * Order is by how much they PERMIT: `unsupported` < `unknown` < `equivalent` <
 * `native`. `unknown` ranks below `equivalent` because it cannot satisfy a
 * requirement, and above `unsupported` because a ceiling that does not mention
 * a capability must not turn a "not measured" into a "definitely not".
 */
const PERMISSIVENESS: Record<ExternalAgentCapabilityLevel, number> = {
  unsupported: 0,
  unknown: 1,
  equivalent: 2,
  native: 3,
}

function stricter(
  a: ExternalAgentCapabilityCell,
  b: ExternalAgentCapabilityCell
): ExternalAgentCapabilityCell {
  return PERMISSIVENESS[b.level] < PERMISSIVENESS[a.level] ? b : a
}

/**
 * Is this layer allowed to overwrite what a weaker layer already said?
 *
 * The rule that makes the ladder safe: a STATIC layer (`refinement`,
 * `adapter-methods`) may only fill in `unknown` or tighten — it can never turn
 * a protocol-level `unsupported` back into `native`, because a preset author
 * has no standing to overrule the protocol. A LIVE layer may overwrite freely
 * in either direction: it is measuring the agent in front of us, and a stale
 * manifest losing to a live handshake is the correct outcome.
 */
function layerMayWiden(layer: ExternalAgentCapabilityLayer): boolean {
  return layer === "live"
}

/**
 * Merge the layers into one effective matrix, in fixed precedence order.
 *
 * Deterministic and pure: the same layers in the same order always produce the
 * same matrix and the same drift list, which is what lets the profile digest be
 * a stable identity.
 */
export function mergeExternalAgentCapabilities(
  layers: readonly ExternalAgentCapabilityLayerInput[]
): { effective: ExternalAgentCapabilityMatrix; drift: ExternalAgentCapabilityDrift[] } {
  const ordered = [...layers].sort(
    (a, b) =>
      EXTERNAL_AGENT_CAPABILITY_LAYERS.indexOf(a.layer) -
      EXTERNAL_AGENT_CAPABILITY_LAYERS.indexOf(b.layer)
  )

  const effective: ExternalAgentCapabilityMatrix = {}
  const drift: ExternalAgentCapabilityDrift[] = []

  for (const { layer, cells } of ordered) {
    for (const id of EXTERNAL_AGENT_CAPABILITY_IDS) {
      const incoming = cells[id]
      if (!incoming) continue
      const current = effective[id]

      if (!current) {
        effective[id] = incoming
        continue
      }

      if (layer === "ceiling") {
        // Ceilings intersect: a host that cannot serve a capability removes it,
        // but a host that says nothing about one must not grant it.
        effective[id] = stricter(current, incoming)
        continue
      }

      if (layerMayWiden(layer)) {
        if (current.level !== "unknown" && current.level !== incoming.level) {
          drift.push({
            capability: id,
            declaredLevel: current.level,
            observedLevel: incoming.level,
            observedBy: layer,
          })
        }
        effective[id] = incoming
        continue
      }

      // Static refinement: fill an `unknown`, or tighten. Never widen.
      if (current.level === "unknown") {
        effective[id] = incoming
      } else {
        effective[id] = stricter(current, incoming)
      }
    }
  }

  return { effective, drift }
}

// ---- Profile ----------------------------------------------------------------

/**
 * What the HOST adds to a session, as opposed to what the agent brings.
 *
 * These widen, so they ride the `live` layer rather than the ceiling: Cognia's
 * lifecycle hooks really do wrap an external turn on desktop
 * (`lib/ai/agent/external/agent-hooks.ts`) and really do not in the CLI, and a
 * ceiling — which may only intersect — could never express the desktop half.
 * They are facts about THIS session on THIS host, which is exactly what the
 * live layer means.
 */
export interface ExternalAgentHostFacts {
  /** Cognia's tool host attached and its broker is running for this session. */
  toolHostRunning: boolean
  /** `dispatch_agent` was actually projected, so per-subagent models exist. */
  subagentDispatchProjected: boolean
  /** This host wraps external turns in Cognia's lifecycle hook runtime. */
  hookRuntimeAvailable: boolean
}

/**
 * Hard limits that can only REMOVE capabilities.
 *
 * Split from {@link ExternalAgentHostFacts} on purpose. A ceiling that could
 * grant would not be a ceiling, and the merge relies on that: the ceiling layer
 * takes the stricter of the two cells and never the more permissive one, so a
 * clamp can be applied last without any risk of it re-enabling something an
 * earlier layer refused.
 */
export interface ExternalAgentHostCeilings {
  /**
   * The platform can run the mandatory sandbox (macOS Seatbelt / Linux
   * bubblewrap). `false` means the agent cannot be launched at all — Cognia
   * never runs an external agent unsandboxed — so every capability clamps to
   * `unsupported` rather than the profile pretending the agent is merely
   * limited.
   */
  sandboxAvailable: boolean
  /** Permission modes the effective policy allows this backend to enforce. */
  enforceablePermissionModes?: readonly string[]
}

/** Reason keys the host layers stamp. Surfaces translate these, never the level. */
export const EXTERNAL_CAPABILITY_REASON_KEYS = {
  noToolHost: "noToolHost",
  noHookRuntime: "noHookRuntime",
  noSandbox: "noSandbox",
  noSubagentDispatch: "noSubagentDispatch",
  notNegotiated: "notNegotiated",
  noProtocolSlot: "noProtocolSlot",
  agentOwned: "agentOwned",
  sidecarOnly: "sidecarOnly",
  adapterMethodMissing: "adapterMethodMissing",
  pluginUndeclared: "pluginUndeclared",
} as const

export type ExternalCapabilityReasonKey =
  (typeof EXTERNAL_CAPABILITY_REASON_KEYS)[keyof typeof EXTERNAL_CAPABILITY_REASON_KEYS]

/**
 * The strongest evidence grade a PLUGIN's own declaration may carry.
 *
 * A contributed adapter is merge layer 2: it speaks for its own code and for
 * the protocol it implements, and for nothing else. `cognia-verified` means a
 * conformance run measured it and `vendor-certified` means the vendor stands
 * behind it — a manifest asserting either is exactly the overclaim the evidence
 * vocabulary exists to prevent. `handshake` and `probe` are live grades and a
 * static declaration has not made either observation.
 */
const PLUGIN_DECLARABLE_EVIDENCE: readonly ExternalAgentCapabilityEvidence[] = [
  "adapter-code",
  "protocol-spec",
  "none",
]

/**
 * Validate a plugin-supplied capability matrix before it becomes merge layer 2.
 *
 * Plugin manifests are third-party data. `mergeExternalAgentCapabilities`
 * enforces the LADDER (a refinement cannot widen what the protocol refused) but
 * performs no shape checking at all, so an unvalidated cell reaches
 * `profile.effective`, the profile digest and every rendering surface intact —
 * and a `level` outside the vocabulary makes `PERMISSIVENESS[level]`
 * `undefined`, which quietly stops the ceiling layer from clamping that cell.
 *
 * Fails closed per cell: anything malformed is DROPPED rather than repaired, so
 * the id falls back to `unknown` — the same state as a plugin that declared
 * nothing, which never satisfies a hard requirement but still lets the
 * handshake prove the adapter works. Over-claimed evidence is clamped rather
 * than dropped: the level is a legitimate statement, only its provenance is not.
 */
export function sanitizePluginCapabilityMatrix(raw: unknown): ExternalAgentCapabilityMatrix {
  if (!raw || typeof raw !== "object") return {}
  const ids = EXTERNAL_AGENT_CAPABILITY_IDS as readonly string[]
  const levels = EXTERNAL_AGENT_CAPABILITY_LEVELS as readonly string[]
  const declarable = PLUGIN_DECLARABLE_EVIDENCE as readonly string[]

  const out: ExternalAgentCapabilityMatrix = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ids.includes(id)) continue
    if (!value || typeof value !== "object") continue
    const cell = value as Record<string, unknown>

    const level = cell.level
    if (typeof level !== "string" || !levels.includes(level)) continue

    const reasonKey = typeof cell.reasonKey === "string" ? cell.reasonKey : undefined
    // Same rule the checked-in manifest answers to: an unexplained refusal is
    // indistinguishable from an unfinished adapter.
    if (level !== "native" && level !== "unknown" && !reasonKey) continue

    const evidence: ExternalAgentCapabilityEvidence =
      typeof cell.evidence === "string" && declarable.includes(cell.evidence)
        ? (cell.evidence as ExternalAgentCapabilityEvidence)
        : "adapter-code"
    // `none` admits nothing was measured, so it may not back a verdict.
    if (evidence === "none" && level !== "unknown") continue

    out[id as ExternalAgentCapabilityId] = {
      level: level as ExternalAgentCapabilityLevel,
      evidence,
      ...(reasonKey ? { reasonKey } : {}),
    }
  }
  return out
}

/**
 * The `live`-layer contribution of the host's own facilities.
 *
 * `hooks.lifecycle` is the clearest case: no external protocol has a slot for
 * Cognia's hooks, so the manifest row is `unknown` for every one of them — the
 * only thing that can answer is whether THIS host runs the hook runtime around
 * the turn.
 */
export function hostFactsCapabilityLayer(
  facts: ExternalAgentHostFacts
): ExternalAgentCapabilityLayerInput {
  const cells: ExternalAgentCapabilityMatrix = {
    "hooks.lifecycle": facts.hookRuntimeAvailable
      ? { level: "equivalent", evidence: "adapter-code", reasonKey: "cogniaHookRuntime" }
      : {
          level: "unsupported",
          evidence: "adapter-code",
          reasonKey: EXTERNAL_CAPABILITY_REASON_KEYS.noHookRuntime,
        },
    "subagents.model-selection":
      facts.toolHostRunning && facts.subagentDispatchProjected
        ? { level: "equivalent", evidence: "probe", reasonKey: "cogniaDispatchAgent" }
        : {
            level: "unsupported",
            evidence: "probe",
            reasonKey: facts.toolHostRunning
              ? EXTERNAL_CAPABILITY_REASON_KEYS.noSubagentDispatch
              : EXTERNAL_CAPABILITY_REASON_KEYS.noToolHost,
          },
  }
  return { layer: "live", cells }
}

/**
 * The ceiling layer. Only ever tightens; see {@link ExternalAgentHostCeilings}.
 */
export function hostCeilingsCapabilityLayer(
  ceilings: ExternalAgentHostCeilings
): ExternalAgentCapabilityLayerInput {
  if (ceilings.sandboxAvailable) return { layer: "ceiling", cells: {} }
  const cells: ExternalAgentCapabilityMatrix = {}
  for (const id of EXTERNAL_AGENT_CAPABILITY_IDS) {
    cells[id] = {
      level: "unsupported",
      evidence: "adapter-code",
      reasonKey: EXTERNAL_CAPABILITY_REASON_KEYS.noSandbox,
    }
  }
  return { layer: "ceiling", cells }
}

/**
 * Everything known about ONE external agent's capabilities, at one moment.
 *
 * Versioned independently of `ResolvedAgentExecutionSpec` (see the module
 * header). `profileVersion` moves when this shape changes; the execution spec's
 * `specVersion` does not move with it.
 */
export interface ExternalAgentCapabilityProfileV1 {
  profileVersion: 1
  /** Built-in, legacy, or `${pluginId}:${adapterId}`. */
  protocol: string
  presetId?: string
  /** Adapter that owns the protocol behaviour (plugin adapters only). */
  adapterId?: string
  pluginId?: string
  /** Version of the plugin/adapter whose declaration was merged. */
  adapterVersion?: string
  /** Version of `protocol/agent-capabilities.json` the protocol row came from. */
  manifestVersion: number
  /** Layer 1+2: what was declared before the agent was contacted. */
  declared: ExternalAgentCapabilityMatrix
  /** Layer 4: what this session's handshake/negotiation reported. Empty pre-connect. */
  live: ExternalAgentCapabilityMatrix
  /** Layer 4 host half, kept so a UI can name the facility that is missing. */
  hostFacts: ExternalAgentHostFacts
  /** Layer 5 inputs, kept so a UI can say WHICH ceiling removed a capability. */
  ceilings: ExternalAgentHostCeilings
  /** The merged answer. Every id in the vocabulary is present. */
  effective: Record<ExternalAgentCapabilityId, ExternalAgentCapabilityCell>
  /** Live facts that contradicted a static declaration. */
  drift: ExternalAgentCapabilityDrift[]
  /** True once a handshake has fed `live`. A pre-handshake profile is advisory. */
  negotiated: boolean
  /** Stable identity; see `computeExternalAgentProfileDigest`. */
  digest: string
}

/** Capabilities the profile says are usable right now. */
export function usableExternalAgentCapabilities(
  profile: ExternalAgentCapabilityProfileV1
): ExternalAgentCapabilityId[] {
  return EXTERNAL_AGENT_CAPABILITY_IDS.filter((id) =>
    isCapabilityUsable(profile.effective[id].level)
  )
}

/** The hard requirements this profile cannot serve, with the reason for each. */
export function missingExternalAgentCapabilities(
  profile: ExternalAgentCapabilityProfileV1,
  requires: readonly ExternalAgentCapabilityId[]
): Array<{ capability: ExternalAgentCapabilityId; cell: ExternalAgentCapabilityCell }> {
  return requires
    .filter((id) => !isCapabilityUsable(profile.effective[id].level))
    .map((id) => ({ capability: id, cell: profile.effective[id] }))
}

// ---- Projection onto the v2 execution contract ------------------------------

/**
 * Reason recorded on a v2 cell that the profile could only answer `unknown`.
 *
 * Deterministic and machine-greppable: the v2 contract has no `unknown`, so an
 * unmeasured capability MUST arrive as `unsupported` — and without this marker
 * it would be indistinguishable from a measured refusal.
 */
export const UNKNOWN_CAPABILITY_SPEC_REASON =
  "external-agent capability is unknown (never measured); fail-closed as unsupported"

export interface ExternalAgentSpecCapabilityProjection {
  /** v2 ids the spec may list as effective. */
  effective: AgentCapabilityId[]
  /** v2 `capabilities.support`, with a reason on everything non-native. */
  support: Partial<Record<AgentCapabilityId, import("./agent-execution").AgentCapabilityEvidence>>
}

/**
 * Project the profile onto the CLOSED v2 vocabulary.
 *
 * Three rules, all of them lossy on purpose:
 *   - external-only ids are dropped (they have no v2 name, and inventing one
 *     would be the `specVersion: 3` migration this contract exists to avoid);
 *   - `unknown` becomes `unsupported` with {@link UNKNOWN_CAPABILITY_SPEC_REASON};
 *   - the full profile does NOT ride along — the digest does, through
 *     `compatibility.recordRef`, and the profile itself stays on the execution
 *     handle where a diagnostics surface can read it without growing the wire
 *     envelope.
 */
/**
 * The v2 `reason` string for a projected cell.
 *
 * v2 `reason` is a diagnostic, not UI copy — the resolver's own strings are
 * English sentences that end up in traces and structured errors. So the i18n
 * `reasonKey` is EMBEDDED rather than resolved: a surface that wants localized
 * copy reads the profile (which still has the key), and a log reader still gets
 * something greppable back to the layer that produced it.
 */
function specReason(
  profile: ExternalAgentCapabilityProfileV1,
  id: AgentCapabilityId,
  cell: ExternalAgentCapabilityCell
): string {
  const key = cell.reasonKey ? ` (${cell.reasonKey})` : ""
  return `external protocol "${profile.protocol}" reports "${id}" as ${cell.level} via ${cell.evidence}${key}`
}

export function projectExternalAgentCapabilitiesToSpec(
  profile: ExternalAgentCapabilityProfileV1
): ExternalAgentSpecCapabilityProjection {
  const effective: AgentCapabilityId[] = []
  const support: ExternalAgentSpecCapabilityProjection["support"] = {}

  for (const id of AGENT_CAPABILITY_IDS) {
    const cell = profile.effective[id]
    if (!cell) continue

    if (cell.level === "native") {
      effective.push(id)
      support[id] = { support: "native" }
      continue
    }

    if (cell.level === "equivalent") {
      effective.push(id)
      support[id] = { support: "equivalent", reason: specReason(profile, id, cell) }
      continue
    }

    support[id] = {
      support: "unsupported",
      reason:
        cell.level === "unknown"
          ? `${UNKNOWN_CAPABILITY_SPEC_REASON} [${profile.protocol}/${id}]`
          : specReason(profile, id, cell),
    }
  }

  return { effective, support }
}
