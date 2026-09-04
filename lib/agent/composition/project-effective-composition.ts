/**
 * Turn a resolved, layered configuration into an
 * {@link AgentCompositionSelectionV1} plus per-axis provenance.
 *
 * This is the domain-neutral half of what the IM facade has done since
 * ADR-0117 (`lib/connectors/composition/im-composition-selection.ts`). An IM
 * conversation and a Bot installation both arrive at the same place: each has
 * its own Dexie config stack, each resolved every axis with a source label,
 * and neither should inherit whatever the desktop composer chip last held.
 *
 * What stays with the caller is the part that is genuinely domain-specific,
 * how the base preset is chosen and how the domain's execution target maps
 * onto an orchestration policy. What lives here is the assembly, so a second
 * caller cannot introduce a second precedence chain by accident.
 *
 * This module does not decide final values. `resolveComposition` still applies
 * every cap, and a projection that asked for more than a preset allows is
 * narrowed there, not here.
 */

import type {
  AgentAuthority,
  AgentCompositionSelectionV1,
  AgentOrchestrationPolicy,
  AutonomyLevel,
  EngagementMode,
} from "@cognia/agent-config-types/agent-composition"

import type { EffectiveValue } from "@/lib/config/effective-value"

/** The axes a layered configuration can supply. */
export type ProjectedCompositionAxis =
  "preset" | "authority" | "orchestration" | "engagement" | "autonomy"

/**
 * Which layer supplied each axis, for a chip or an override dialog.
 *
 * Provenance and warnings are kept apart on purpose. An
 * `AgentCompositionWarning` records a DOWNGRADE, something the resolver
 * refused. A source records where a value came from. Merging them would make
 * "the installation default won" render as a failure.
 */
export type ProjectedCompositionProvenance<S extends string> = Record<ProjectedCompositionAxis, S>

export interface ProjectedCompositionOrchestration<S extends string> {
  policy: AgentOrchestrationPolicy
  /**
   * The id the engine runs, a team id for `team`, a workflow id for
   * `workflow`. Absent for `direct`, and absent leaves whatever `base` carried
   * rather than clearing it.
   */
  ref?: string
  source: S
}

export interface ProjectEffectiveCompositionInput<S extends string> {
  /**
   * The preset-shaped starting point, normally from a legacy mode id or a
   * definition's preset reference. Every axis below is layered on top.
   */
  base: AgentCompositionSelectionV1
  presetSource: S
  orchestration: ProjectedCompositionOrchestration<S>
  engagement: EffectiveValue<EngagementMode, S>
  autonomy: EffectiveValue<AutonomyLevel, S>
  /**
   * Authority is the one axis that may resolve to nothing. It is then OMITTED
   * rather than defaulted, so a preset recommendation still applies. An
   * explicit value is an opinion and does come through.
   */
  authority: EffectiveValue<AgentAuthority | undefined, S>
  /** Carried through unchanged so the runtime binding stays ADR-0090's. */
  runtimeBindingRef?: string
}

export interface ProjectedComposition<S extends string> {
  selection: AgentCompositionSelectionV1
  provenance: ProjectedCompositionProvenance<S>
}

export function projectEffectiveComposition<S extends string>(
  input: ProjectEffectiveCompositionInput<S>
): ProjectedComposition<S> {
  const selection: AgentCompositionSelectionV1 = {
    ...input.base,
    orchestration: input.orchestration.policy,
    engagement: input.engagement.effective,
    autonomy: input.autonomy.effective,
    ...(input.orchestration.ref ? { orchestrationRef: input.orchestration.ref } : {}),
    ...(input.authority.effective ? { authority: input.authority.effective } : {}),
    ...(input.runtimeBindingRef ? { runtimeBindingRef: input.runtimeBindingRef } : {}),
  }

  return {
    selection,
    provenance: {
      preset: input.presetSource,
      authority: input.authority.source,
      orchestration: input.orchestration.source,
      engagement: input.engagement.source,
      autonomy: input.autonomy.source,
    },
  }
}
