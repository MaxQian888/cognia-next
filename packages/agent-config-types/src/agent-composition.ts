// Composed agent modes (ADR-0117).
//
// A "mode" used to be one flat enum in `types/agent/agent-mode.ts` that mixed
// persona (`research`), permission posture (`plan`, `build`), orchestration
// (`workflow`) and provenance (`plugin`, `custom`). This module replaces that
// single axis with five independent ones, WITHOUT re-declaring any authority
// that already exists:
//
//   - Authority reuses {@link AgentPermissionMode} — the SDK's own union.
//   - Runtime binding stays with `AgentExecutionPolicy` / the resolved spec.
//     Nothing here re-derives a runtime; a composition only *references* one.
//
// The two genuinely new axes are tool presentation and orchestration.

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
 * `direct` is one agent loop. `subagent` allows delegation to children.
 * `workflow` routes through the visual workflow engine. `verified-fresh-agent`
 * additionally requires an independent reviewer with its own context, which
 * may never inherit the producing agent's ceiling.
 */
export type AgentOrchestrationPolicy = "direct" | "subagent" | "workflow" | "verified-fresh-agent"

export const AGENT_ORCHESTRATION_POLICIES: readonly AgentOrchestrationPolicy[] = [
  "direct",
  "subagent",
  "workflow",
  "verified-fresh-agent",
]

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
  }
  /**
   * The highest authority this preset may ever resolve to. Minimal pins itself
   * to `plan` so no selection or legacy migration can turn it into an editor.
   */
  maxAuthority?: AgentAuthority
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
  /**
   * Reference to an `AgentExecutionPolicy` binding. The composition never
   * describes a runtime itself — it points at the existing authority.
   */
  runtimeBindingRef?: string
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
  | "presentation-unavailable"
  | "orchestration-unavailable"

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
  for (const key of ["runtimeBindingRef", "legacyModeId"] as const) {
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
