// Composed agent modes (ADR-0117).
//
// A "mode" used to be one flat enum in `types/agent/agent-mode.ts` that mixed
// persona (`research`), permission posture (`plan`, `build`), orchestration
// (`workflow`) and provenance (`plugin`, `custom`). This module replaces that
// single axis with independent ones, WITHOUT re-declaring any authority
// that already exists:
//
//   - Authority reuses {@link AgentPermissionMode} — the SDK's own union.
//   - Runtime binding stays with `AgentExecutionPolicy` / the resolved spec.
//     Nothing here re-derives a runtime; a composition only *references* one.
//
// The genuinely new axes are tool presentation, orchestration, engagement and
// autonomy. Engagement and autonomy were added when the IM connector's own
// mode stack (`ConnectorMode` × `ImExecutionTarget`) was folded into this one,
// so "mode" means the same thing on the desktop and in a chat platform. Both
// are deliberately narrow:
//
//   - Engagement names an *attachment* mechanism that already existed
//     implicitly (inline capture vs a durable ExecutionRun vs a human
//     assignee). It never chooses an executor — orchestration does.
//   - Autonomy is a *cap* on authority plus a *floor* on the human ceremony a
//     run owes (`lib/policy/risk/ceremony.ts`). It adds no third permission
//     mechanism of its own.

import type { ValidationResult } from "./agent-execution"
import type { AgentPermissionMode } from "./index"

/** Wire-format version of {@link ResolvedAgentCompositionV1}. */
export const AGENT_COMPOSITION_SCHEMA_VERSION = 1

// ---- Axis 2: authority ------------------------------------------------------

/**
 * The permission modes a *user-selectable* composition may request.
 *
 * A deliberate subset of {@link AgentPermissionMode}, not a second union:
 * `dontAsk` and `auto` remain reachable programmatically (an Agent Team lead
 * may run a child at `dontAsk`) but are not offered as a mode axis, matching
 * the safety-ordered cycle in `components/chat/permission-mode-indicator.tsx`.
 */
export type AgentAuthority = Extract<
  AgentPermissionMode,
  "plan" | "default" | "acceptEdits" | "bypassPermissions"
>

export const AGENT_AUTHORITIES: readonly AgentAuthority[] = [
  "plan",
  "default",
  "acceptEdits",
  "bypassPermissions",
]

/**
 * Escalation rank, lowest privilege first. Typed as a total record over
 * {@link AgentPermissionMode} so that adding a seventh SDK permission mode is
 * a compile error here rather than a silently unranked value that
 * {@link narrowAuthority} would treat as maximally privileged.
 *
 * Mirrors the order of `AGENT_PERMISSION_MODES` in `./index`; duplicated as a
 * rank map instead of imported because a value import would drag the whole
 * ~750-importer barrel into the sidecar and CLI, which only need this leaf.
 */
export const AUTHORITY_RANK: Record<AgentPermissionMode, number> = {
  plan: 0,
  default: 1,
  acceptEdits: 2,
  dontAsk: 3,
  auto: 4,
  bypassPermissions: 5,
}

/**
 * The less-privileged of two permission modes.
 *
 * This is the whole child-agent rule: a nested execution may narrow its
 * parent's ceiling and may never widen it. Callers pass the parent ceiling
 * first, so an unknown/absent request simply keeps the ceiling.
 */
export function narrowAuthority(
  ceiling: AgentPermissionMode,
  requested: AgentPermissionMode | undefined
): AgentPermissionMode {
  if (requested === undefined) return ceiling
  return AUTHORITY_RANK[requested] < AUTHORITY_RANK[ceiling] ? requested : ceiling
}

/** Whether `requested` would escalate beyond `ceiling`. */
export function widensAuthority(
  ceiling: AgentPermissionMode,
  requested: AgentPermissionMode
): boolean {
  return AUTHORITY_RANK[requested] > AUTHORITY_RANK[ceiling]
}

// ---- Axis 3: tool presentation ---------------------------------------------

/**
 * How tools are exposed to the model.
 *
 * `native` is one schema-described tool per capability. `code` exposes a single
 * `run_code` tool plus a typed SDK, so the model composes calls in a sandbox
 * instead of emitting one tool call per step. `both` offers each.
 *
 * `code` is read-only in the first release: only tools whose catalog entry sets
 * `programmaticReadOnly` are reachable from the SDK. That flag is a first-party
 * allowlist and is deliberately NOT derived from the MCP `readOnlyHint`
 * annotation, which third-party servers declare about themselves.
 */
export type ToolPresentationMode = "native" | "code" | "both"

export const TOOL_PRESENTATION_MODES: readonly ToolPresentationMode[] = ["native", "code", "both"]

// ---- Axis 4: orchestration --------------------------------------------------

/**
 * How the turn is decomposed.
 *
 * `direct` is one agent loop. `subagent` allows delegation to children through
 * the SDK's own child-agent mechanism. `team` hands the turn to the Agent Team
 * lifecycle, which is a different runtime with its own gates and trajectory —
 * conflating it with `subagent` would make one value mean two schedulers.
 * `workflow` routes through the visual workflow engine. `verified-fresh-agent`
 * additionally requires an independent reviewer with its own context, which
 * may never inherit the producing agent's ceiling.
 *
 * `team` and `workflow` name *which* engine runs; the engine's target id
 * travels separately in `orchestrationRef`, because the id's storage of record
 * stays where it already lives (a conversation override's `teamId`, a
 * session's binding). A composition never becomes a second router.
 */
export type AgentOrchestrationPolicy =
  "direct" | "subagent" | "team" | "workflow" | "verified-fresh-agent"

export const AGENT_ORCHESTRATION_POLICIES: readonly AgentOrchestrationPolicy[] = [
  "direct",
  "subagent",
  "team",
  "workflow",
  "verified-fresh-agent",
]

// ---- Axis 6: engagement -----------------------------------------------------

/**
 * How a run is attached to whoever asked for it.
 *
 * This is not "who executes" — that is orchestration. It is the difference
 * between an answer that comes back in the same breath, a task that detaches
 * and reports on its own, and work that leaves the machine entirely.
 *
 * `inline`     — the turn's reply is the answer. One request, one response.
 * `background` — the turn mints a durable ExecutionRun, acknowledges, reports
 *                milestones, and stays steerable and stoppable until it
 *                settles. Same executor as `inline` when orchestration is
 *                `direct`; only the attachment differs, which is exactly why
 *                this cannot be an orchestration value.
 * `human`      — no agent loop runs at all; the work is assigned to a person.
 */
export type EngagementMode = "inline" | "background" | "human"

export const ENGAGEMENT_MODES: readonly EngagementMode[] = ["inline", "background", "human"]

// ---- Axis 7: autonomy -------------------------------------------------------

/**
 * How much a run may do before it owes a human a checkpoint.
 *
 * Authority answers "may the model call this tool, and does each call ask?".
 * Autonomy answers "does this *run* owe a human a checkpoint — before it
 * starts, before its product ships, on every turn?". Neither expresses the
 * other: no permission mode can say "run at full authority but hold the
 * finished reply for review", and no ceremony can say "this tool is off".
 *
 * The five levels map onto the IM connector's old three modes without loss:
 * `observe` was `manual`, `suggest` was `draft`, `act` was `auto`. `confirm`
 * and `autopilot` are the two rungs that mode stack never had.
 */
export type AutonomyLevel = "observe" | "suggest" | "confirm" | "act" | "autopilot"

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = [
  "observe",
  "suggest",
  "confirm",
  "act",
  "autopilot",
]

/**
 * Escalation rank, least autonomous first. A total record so adding a level is
 * a compile error here rather than an unranked value that comparisons would
 * silently treat as maximal.
 */
export const AUTONOMY_RANK: Record<AutonomyLevel, number> = {
  observe: 0,
  suggest: 1,
  confirm: 2,
  act: 3,
  autopilot: 4,
}

/** The less autonomous of two levels. Mirrors {@link narrowAuthority}. */
export function narrowAutonomy(
  ceiling: AutonomyLevel,
  requested: AutonomyLevel | undefined
): AutonomyLevel {
  if (requested === undefined) return ceiling
  return AUTONOMY_RANK[requested] < AUTONOMY_RANK[ceiling] ? requested : ceiling
}

/**
 * The highest authority a level may resolve to, or `undefined` for uncapped.
 *
 * This is the whole of autonomy's interaction with the permission system: it
 * feeds {@link narrowAuthority} as one more ceiling in the same loop that
 * already applies the preset cap and the parent ceiling. There is no second
 * enforcement point.
 *
 * `autopilot` returns `undefined` — it removes the *operator's* floor only. It
 * can never lower a ceremony that risk classification raised; that opt-out is
 * a separate, operator-visible switch (`riskGating`), deliberately not folded
 * in here so the "gate on positive evidence" invariant stays intact.
 */
export function autonomyAuthorityCap(autonomy: AutonomyLevel): AgentAuthority | undefined {
  switch (autonomy) {
    // `observe` never runs a turn at all. The cap is still the strictest
    // value rather than `undefined`, so a caller that ignores the no-run rule
    // degrades to read-only instead of inheriting the host default.
    case "observe":
      return "plan"
    case "suggest":
      return "plan"
    case "confirm":
      return "default"
    case "act":
      return "acceptEdits"
    case "autopilot":
      return undefined
  }
}

// ---- Axis 1: preset ---------------------------------------------------------

export type AgentPresetSource = "builtin" | "custom" | "plugin"

/**
 * `developer-only` presets (Creator) resolve normally when selected — the gate
 * is on *offering* them, so an already-selected Creator session keeps working
 * if developer mode is toggled off mid-session rather than silently changing
 * behaviour underneath a running turn.
 */
export type AgentPresetVisibility = "always" | "developer-only"

export interface AgentPresetDefinitionV1 {
  id: string
  source: AgentPresetSource
  /** Stable across edits; bumped when prompt or default tools change. */
  version: string
  name: string
  description: string
  /** Lucide icon name, matching the legacy `AgentModeConfig.icon`. */
  icon?: string
  /** Appended to the base system prompt; never replaces it. */
  systemPromptDelta?: string
  /** Tool ids this preset enables by default. Empty means "host default". */
  defaultToolSet?: string[]
  /** Axis values the preset recommends; a user selection still wins. */
  recommends?: {
    authority?: AgentAuthority
    toolPresentation?: ToolPresentationMode
    orchestration?: AgentOrchestrationPolicy
    engagement?: EngagementMode
    autonomy?: AutonomyLevel
  }
  /**
   * The highest authority this preset may ever resolve to. Minimal pins itself
   * to `plan` so no selection or legacy migration can turn it into an editor.
   */
  maxAuthority?: AgentAuthority
  /**
   * The most autonomous this preset may ever resolve to. Separate from
   * {@link AgentPresetDefinitionV1.maxAuthority} because a preset can want a
   * high tool authority with a mandatory review step, or the reverse.
   */
  maxAutonomy?: AutonomyLevel
  visibility?: AgentPresetVisibility
  /** Hidden from the picker unless the caller opts into experiments. */
  experimental?: boolean
  outputFormat?: "text" | "code" | "html" | "react" | "markdown"
  previewEnabled?: boolean
  /** Legacy `AgentModeConfig.id` this preset replaces, when it replaces one. */
  legacyModeId?: string
}

// ---- Selection --------------------------------------------------------------

/**
 * What the user chose. Every axis except the preset is optional: an absent
 * axis takes the preset's recommendation, then the host default.
 *
 * Stored per session. The app-level value seeds new sessions only — an active
 * session's composition is its own, so a global preference change can never
 * retarget a turn that is already running.
 */
export interface AgentCompositionSelectionV1 {
  presetId: string
  authority?: AgentAuthority
  toolPresentation?: ToolPresentationMode
  orchestration?: AgentOrchestrationPolicy
  engagement?: EngagementMode
  autonomy?: AutonomyLevel
  /**
   * The id the chosen orchestration engine runs — a team id for `team`, a
   * workflow id for `workflow`. Carried, never owned: the storage of record
   * stays with whatever already holds the binding, so the composition cannot
   * drift from it.
   */
  orchestrationRef?: string
  /**
   * Reference to an `AgentExecutionPolicy` binding. The composition never
   * describes a runtime itself, it points at the existing authority.
   *
   * NOT the imported-session resume marker. This field used to carry an
   * external agent's native session id for imported conversations, a third
   * unrelated meaning on top of its documented one and the runtime lane. That
   * moved to {@link verifiedNativeResume}.
   */
  runtimeBindingRef?: string
  /**
   * This imported conversation has been verified against the external agent
   * that produced it, so its turns may resume the agent's own native session
   * instead of starting a fresh one.
   *
   * A marker, not an id: the native session id already lives on the session row
   * (`importRuntimeBinding.nativeSessionId`) and the verification does not
   * change it. What is per-session here is the DECISION, which is why it rides
   * the selection.
   *
   * Deliberately absent from {@link compositionDigestPayload}: verifying a
   * resume target does not change what the composition is, and a turn's frozen
   * composition identity must not move because of it.
   */
  verifiedNativeResume?: true
  /**
   * The `agentModeId` this selection was migrated from, kept so an older
   * client (or an export) can still round-trip the session.
   */
  legacyModeId?: string
}

// ---- Resolution -------------------------------------------------------------

/**
 * Why a resolution did not land on what was asked for. Every value is a
 * downgrade or a substitution — there is no reason code for an escalation,
 * because escalation is refused rather than recorded.
 */
export type AgentCompositionFallbackReason =
  | "unknown-preset"
  | "unknown-legacy-mode"
  | "authority-capped-by-preset"
  | "authority-capped-by-ceiling"
  | "authority-capped-by-autonomy"
  | "autonomy-capped-by-preset"
  | "autonomy-capped-by-ceiling"
  | "presentation-unavailable"
  | "orchestration-unavailable"
  | "engagement-unavailable"

export interface AgentCompositionWarning {
  reason: AgentCompositionFallbackReason
  /** The value that was asked for, when there was one. */
  requested?: string
  /** What was used instead. */
  applied: string
}

/**
 * The frozen result for one turn.
 *
 * Frozen is the operative word: a composition is resolved at the turn boundary
 * and may not change until the turn ends, so every model call inside a turn is
 * describable by exactly one `compositionDigest`.
 */
export interface ResolvedAgentCompositionV1 {
  schemaVersion: typeof AGENT_COMPOSITION_SCHEMA_VERSION
  presetId: string
  presetVersion: string
  presetSource: AgentPresetSource
  authority: AgentPermissionMode
  toolPresentation: ToolPresentationMode
  orchestration: AgentOrchestrationPolicy
  engagement: EngagementMode
  autonomy: AutonomyLevel
  orchestrationRef?: string
  runtimeBindingRef?: string
  /** SHA-256 of the final system prompt. */
  promptDigest: string
  /** SHA-256 of the ordered `(name, schema, visibility)` tool list. */
  toolDigest: string
  /** SHA-256 over {@link compositionDigestPayload}. */
  compositionDigest: string
  /** The sibling identity from `resolveAgentExecutionSpec()`, when resolved. */
  executionFingerprint?: string
  /** Non-empty when the resolver had to substitute anything. */
  warnings: AgentCompositionWarning[]
  legacyModeId?: string
}

/**
 * The exact object `compositionDigest` covers.
 *
 * Deliberately excludes `warnings`, `legacyModeId` and `executionFingerprint`:
 * two hosts that resolved the same composition by different routes (one from a
 * modern selection, one migrated from `agentModeId`) must agree on the digest,
 * otherwise every migrated session would look like a behaviour change to
 * replay diffing. It also excludes session and account ids so a digest is
 * comparable across users.
 */
export function compositionDigestPayload(
  resolved: Pick<
    ResolvedAgentCompositionV1,
    | "presetId"
    | "presetVersion"
    | "presetSource"
    | "authority"
    | "toolPresentation"
    | "orchestration"
    | "engagement"
    | "autonomy"
    | "orchestrationRef"
    | "runtimeBindingRef"
    | "promptDigest"
    | "toolDigest"
  >
): Record<string, unknown> {
  return {
    schemaVersion: AGENT_COMPOSITION_SCHEMA_VERSION,
    presetId: resolved.presetId,
    presetVersion: resolved.presetVersion,
    presetSource: resolved.presetSource,
    authority: resolved.authority,
    toolPresentation: resolved.toolPresentation,
    orchestration: resolved.orchestration,
    engagement: resolved.engagement,
    autonomy: resolved.autonomy,
    orchestrationRef: resolved.orchestrationRef,
    runtimeBindingRef: resolved.runtimeBindingRef,
    promptDigest: resolved.promptDigest,
    toolDigest: resolved.toolDigest,
  }
}

// ---- Guards and validators --------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export function isAgentAuthority(v: unknown): v is AgentAuthority {
  return typeof v === "string" && (AGENT_AUTHORITIES as readonly string[]).includes(v)
}

export function isToolPresentationMode(v: unknown): v is ToolPresentationMode {
  return typeof v === "string" && (TOOL_PRESENTATION_MODES as readonly string[]).includes(v)
}

export function isAgentOrchestrationPolicy(v: unknown): v is AgentOrchestrationPolicy {
  return typeof v === "string" && (AGENT_ORCHESTRATION_POLICIES as readonly string[]).includes(v)
}

export function isEngagementMode(v: unknown): v is EngagementMode {
  return typeof v === "string" && (ENGAGEMENT_MODES as readonly string[]).includes(v)
}

export function isAutonomyLevel(v: unknown): v is AutonomyLevel {
  return typeof v === "string" && (AUTONOMY_LEVELS as readonly string[]).includes(v)
}

export function validateAgentCompositionSelection(
  v: unknown
): ValidationResult<AgentCompositionSelectionV1> {
  if (!isRecord(v)) return { ok: false, errors: ["selection must be an object"] }
  const errors: string[] = []

  if (typeof v.presetId !== "string" || v.presetId.length === 0) {
    errors.push("presetId must be a non-empty string")
  }
  if (v.authority !== undefined && !isAgentAuthority(v.authority)) {
    errors.push(`authority must be one of ${AGENT_AUTHORITIES.join("|")}`)
  }
  if (v.toolPresentation !== undefined && !isToolPresentationMode(v.toolPresentation)) {
    errors.push(`toolPresentation must be one of ${TOOL_PRESENTATION_MODES.join("|")}`)
  }
  if (v.orchestration !== undefined && !isAgentOrchestrationPolicy(v.orchestration)) {
    errors.push(`orchestration must be one of ${AGENT_ORCHESTRATION_POLICIES.join("|")}`)
  }
  if (v.engagement !== undefined && !isEngagementMode(v.engagement)) {
    errors.push(`engagement must be one of ${ENGAGEMENT_MODES.join("|")}`)
  }
  if (v.autonomy !== undefined && !isAutonomyLevel(v.autonomy)) {
    errors.push(`autonomy must be one of ${AUTONOMY_LEVELS.join("|")}`)
  }
  for (const key of ["runtimeBindingRef", "orchestrationRef", "legacyModeId"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "string") {
      errors.push(`${key} must be a string when present`)
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: v as unknown as AgentCompositionSelectionV1 }
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

export function validateResolvedAgentComposition(
  v: unknown
): ValidationResult<ResolvedAgentCompositionV1> {
  if (!isRecord(v)) return { ok: false, errors: ["composition must be an object"] }
  const errors: string[] = []

  if (v.schemaVersion !== AGENT_COMPOSITION_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${AGENT_COMPOSITION_SCHEMA_VERSION}`)
  }
  for (const key of ["presetId", "presetVersion"] as const) {
    if (typeof v[key] !== "string" || (v[key] as string).length === 0) {
      errors.push(`${key} must be a non-empty string`)
    }
  }
  if (v.presetSource !== "builtin" && v.presetSource !== "custom" && v.presetSource !== "plugin") {
    errors.push("presetSource must be one of builtin|custom|plugin")
  }
  if (typeof v.authority !== "string" || !(v.authority in AUTHORITY_RANK)) {
    errors.push("authority must be a known permission mode")
  }
  if (!isToolPresentationMode(v.toolPresentation)) {
    errors.push(`toolPresentation must be one of ${TOOL_PRESENTATION_MODES.join("|")}`)
  }
  if (!isAgentOrchestrationPolicy(v.orchestration)) {
    errors.push(`orchestration must be one of ${AGENT_ORCHESTRATION_POLICIES.join("|")}`)
  }
  if (!isEngagementMode(v.engagement)) {
    errors.push(`engagement must be one of ${ENGAGEMENT_MODES.join("|")}`)
  }
  if (!isAutonomyLevel(v.autonomy)) {
    errors.push(`autonomy must be one of ${AUTONOMY_LEVELS.join("|")}`)
  }
  for (const key of ["promptDigest", "toolDigest", "compositionDigest"] as const) {
    if (typeof v[key] !== "string" || !DIGEST_PATTERN.test(v[key] as string)) {
      errors.push(`${key} must be a sha256:<64 hex> digest`)
    }
  }
  if (!Array.isArray(v.warnings)) {
    errors.push("warnings must be an array")
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: v as unknown as ResolvedAgentCompositionV1 }
}
