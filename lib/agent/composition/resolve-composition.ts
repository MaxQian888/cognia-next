/**
 * Resolve a composition for one turn (ADR-0117).
 *
 * Synchronous and pure. It decides every axis value, refuses every escalation,
 * and records a warning for each substitution. The `compositionDigest` is
 * stamped afterwards by `withCompositionDigest` in `./digest`, because hashing
 * is async and nothing in the turn needs the digest before the first model
 * call.
 *
 * What this module deliberately does NOT do:
 *
 *   - choose a runtime. `resolveAgentExecutionSpec()` owns that; a composition
 *     only carries a reference to the binding it was resolved against.
 *   - widen anything. Every axis is "the narrower of what was asked and what is
 *     allowed", so a child agent's resolution can only ever be a subset of its
 *     parent's ceiling.
 */

import {
  autonomyAuthorityCap,
  narrowAuthority,
  narrowAutonomy,
} from "@cognia/agent-config-types/agent-composition"
import { AGENT_COMPOSITION_SCHEMA_VERSION } from "@cognia/agent-config-types/agent-composition"
import type {
  AgentCompositionSelectionV1,
  AgentCompositionWarning,
  AgentOrchestrationPolicy,
  AgentPresetDefinitionV1,
  AutonomyLevel,
  EngagementMode,
  ResolvedAgentCompositionV1,
  ToolPresentationMode,
} from "@cognia/agent-config-types/agent-composition"
import type { AgentPermissionMode } from "@cognia/agent-config-types"

import { STANDARD_PRESET, STANDARD_PRESET_ID } from "./preset-catalog"
import { selectionFromLegacyModeId } from "./legacy-mode-mapping"

/** Axis values a host falls back to when neither selection nor preset says. */
export interface CompositionHostDefaults {
  authority: AgentPermissionMode
  toolPresentation: ToolPresentationMode
  orchestration: AgentOrchestrationPolicy
  engagement: EngagementMode
  autonomy: AutonomyLevel
}

/**
 * `autonomy: "autopilot"` is deliberate and is NOT a claim that the host runs
 * unattended. It is the only value that makes the autonomy axis *inert*: it
 * caps no authority and floors no ceremony, which is precisely the behaviour
 * every surface had before the axis existed. A surface that means something by
 * autonomy — the IM connector projecting its `auto`/`draft`/`manual` modes, a
 * preset, a user picking a level — says so explicitly. Defaulting to any other
 * level would silently narrow a desktop user who had chosen
 * `bypassPermissions`, which is a behaviour change disguised as a default.
 */
export const DEFAULT_HOST_DEFAULTS: CompositionHostDefaults = {
  authority: "default",
  toolPresentation: "native",
  orchestration: "direct",
  engagement: "inline",
  autonomy: "autopilot",
}

export interface ResolveCompositionInput {
  /** The session's selection. Absent means "migrate `legacyModeId`". */
  selection?: AgentCompositionSelectionV1
  /** Legacy `agentModeId`, used only when there is no modern selection. */
  legacyModeId?: string | null
  presets: readonly AgentPresetDefinitionV1[]
  /**
   * The parent's permission ceiling for a child agent. Absent for a root turn,
   * which is bounded by its preset and the host default only.
   */
  ceiling?: AgentPermissionMode
  /**
   * The parent's resolved autonomy for a child agent. A child may be less
   * autonomous than its parent and never more, mirroring the authority rule.
   */
  autonomyCeiling?: AutonomyLevel
  hostDefaults?: CompositionHostDefaults
  /**
   * Presentations this host can actually run. `code` is absent whenever the
   * strict sandbox is unavailable: the code path fails closed rather than
   * executing generated code unsandboxed, and the turn degrades to `native`
   * with a visible warning instead of silently pretending.
   */
  supportedToolPresentations?: readonly ToolPresentationMode[]
  supportedOrchestrations?: readonly AgentOrchestrationPolicy[]
  /**
   * Engagements this host can actually run. A shell with no durable
   * ExecutionRun store cannot honour `background`, and degrading loudly to
   * `inline` beats accepting a task that would never report back.
   */
  supportedEngagements?: readonly EngagementMode[]
  /** SHA-256 of the final system prompt, from `./digest`. */
  promptDigest: string
  /** SHA-256 of the ordered tool surface, from `./digest`. */
  toolDigest: string
  /** From `resolveAgentExecutionSpec()`, when the spec is already resolved. */
  executionFingerprint?: string
}

export type UndigestedComposition = Omit<ResolvedAgentCompositionV1, "compositionDigest">

function findPreset(
  presets: readonly AgentPresetDefinitionV1[],
  presetId: string
): AgentPresetDefinitionV1 | undefined {
  return presets.find((preset) => preset.id === presetId)
}

/**
 * Resolve every axis.
 *
 * Precedence per axis is selection → preset recommendation → host default.
 * Caps are applied after precedence, never before, so a warning names what the
 * user actually asked for rather than an intermediate value.
 */
export function resolveComposition(input: ResolveCompositionInput): UndigestedComposition {
  const warnings: AgentCompositionWarning[] = []
  const hostDefaults = input.hostDefaults ?? DEFAULT_HOST_DEFAULTS

  // --- selection -----------------------------------------------------------
  let selection: AgentCompositionSelectionV1
  if (input.selection) {
    selection = input.selection
  } else {
    const knownPresetIds = new Set(input.presets.map((preset) => preset.id))
    const migrated = selectionFromLegacyModeId(input.legacyModeId, knownPresetIds)
    selection = migrated.selection
    if (migrated.warning) warnings.push(migrated.warning)
  }

  // --- preset --------------------------------------------------------------
  let preset = findPreset(input.presets, selection.presetId)
  if (!preset) {
    warnings.push({
      reason: "unknown-preset",
      requested: selection.presetId,
      applied: STANDARD_PRESET_ID,
    })
    // Standard is used even if the caller's catalog omitted it: an empty
    // catalog must still produce a usable, unprivileged composition rather
    // than throwing in the middle of a turn.
    preset = findPreset(input.presets, STANDARD_PRESET_ID) ?? STANDARD_PRESET
  }

  // --- autonomy ------------------------------------------------------------
  // Resolved before authority because it contributes one of authority's caps.
  let autonomy: AutonomyLevel =
    selection.autonomy ?? preset.recommends?.autonomy ?? hostDefaults.autonomy
  if (preset.maxAutonomy) {
    const capped = narrowAutonomy(preset.maxAutonomy, autonomy)
    if (capped !== autonomy) {
      warnings.push({ reason: "autonomy-capped-by-preset", requested: autonomy, applied: capped })
      autonomy = capped
    }
  }
  if (input.autonomyCeiling) {
    const capped = narrowAutonomy(input.autonomyCeiling, autonomy)
    if (capped !== autonomy) {
      warnings.push({ reason: "autonomy-capped-by-ceiling", requested: autonomy, applied: capped })
      autonomy = capped
    }
  }

  // --- authority -----------------------------------------------------------
  const requestedAuthority: AgentPermissionMode =
    selection.authority ?? preset.recommends?.authority ?? hostDefaults.authority

  let authority = requestedAuthority
  if (preset.maxAuthority) {
    const capped = narrowAuthority(preset.maxAuthority, authority)
    if (capped !== authority) {
      warnings.push({
        reason: "authority-capped-by-preset",
        requested: authority,
        applied: capped,
      })
      authority = capped
    }
  }
  // The autonomy cap is a third input to the SAME narrowing loop — not a
  // second permission system. It sits after the preset cap and before the
  // parent ceiling so a warning names the value the caller actually asked for.
  const autonomyCap = autonomyAuthorityCap(autonomy)
  if (autonomyCap) {
    const capped = narrowAuthority(autonomyCap, authority)
    if (capped !== authority) {
      warnings.push({
        reason: "authority-capped-by-autonomy",
        requested: authority,
        applied: capped,
      })
      authority = capped
    }
  }
  if (input.ceiling) {
    const capped = narrowAuthority(input.ceiling, authority)
    if (capped !== authority) {
      warnings.push({
        reason: "authority-capped-by-ceiling",
        requested: authority,
        applied: capped,
      })
      authority = capped
    }
  }

  // --- tool presentation ---------------------------------------------------
  let toolPresentation: ToolPresentationMode =
    selection.toolPresentation ??
    preset.recommends?.toolPresentation ??
    hostDefaults.toolPresentation
  if (
    input.supportedToolPresentations &&
    !input.supportedToolPresentations.includes(toolPresentation)
  ) {
    warnings.push({
      reason: "presentation-unavailable",
      requested: toolPresentation,
      applied: "native",
    })
    toolPresentation = "native"
  }

  // --- orchestration -------------------------------------------------------
  let orchestration: AgentOrchestrationPolicy =
    selection.orchestration ?? preset.recommends?.orchestration ?? hostDefaults.orchestration
  if (input.supportedOrchestrations && !input.supportedOrchestrations.includes(orchestration)) {
    warnings.push({
      reason: "orchestration-unavailable",
      requested: orchestration,
      applied: "direct",
    })
    orchestration = "direct"
  }

  // --- engagement ----------------------------------------------------------
  let engagement: EngagementMode =
    selection.engagement ?? preset.recommends?.engagement ?? hostDefaults.engagement
  if (input.supportedEngagements && !input.supportedEngagements.includes(engagement)) {
    warnings.push({ reason: "engagement-unavailable", requested: engagement, applied: "inline" })
    engagement = "inline"
  }

  return {
    schemaVersion: AGENT_COMPOSITION_SCHEMA_VERSION,
    presetId: preset.id,
    presetVersion: preset.version,
    presetSource: preset.source,
    authority,
    toolPresentation,
    orchestration,
    engagement,
    autonomy,
    orchestrationRef: selection.orchestrationRef,
    runtimeBindingRef: selection.runtimeBindingRef,
    promptDigest: input.promptDigest,
    toolDigest: input.toolDigest,
    executionFingerprint: input.executionFingerprint,
    warnings,
    legacyModeId: selection.legacyModeId,
  }
}

/**
 * Resolve a child agent's composition under its parent's resolved authority.
 *
 * The parent's *resolved* authority is the ceiling, not the parent's preset cap
 * — a parent that was itself capped must not hand its child the higher value it
 * asked for and did not get.
 */
export function resolveChildComposition(
  parent: Pick<ResolvedAgentCompositionV1, "authority" | "autonomy">,
  input: Omit<ResolveCompositionInput, "ceiling" | "autonomyCeiling">
): UndigestedComposition {
  return resolveComposition({
    ...input,
    ceiling: parent.authority,
    autonomyCeiling: parent.autonomy,
  })
}
