/**
 * Project a Bot's layered configuration onto an `AgentCompositionSelectionV1`.
 *
 * The IM facade does this for a conversation. A Bot has the same shape of
 * problem and must not grow a second answer to it, so the assembly is the
 * shared `projectEffectiveComposition` and only the two Bot-specific decisions
 * live here:
 *
 *   1. Orchestration is DERIVED from the executor, never requested. A Bot that
 *      runs a workflow orchestrates as `workflow`, and letting a config layer
 *      say otherwise would let the two disagree.
 *   2. Every axis is resolved nearest-layer-first and then NARROWED by the
 *      resolved policy ceiling. The narrowing is visible in the provenance, so
 *      a settings panel can say "the organisation capped this" rather than
 *      showing a value the user never chose with no explanation.
 */

import {
  narrowAuthority,
  narrowAutonomy,
  type AgentAuthority,
  type AgentOrchestrationPolicy,
  type AutonomyLevel,
  type EngagementMode,
} from "@cognia/agent-config-types/agent-composition"

import { STANDARD_PRESET_ID } from "@/lib/agent/composition/preset-catalog"
import {
  projectEffectiveComposition,
  type ProjectedComposition,
} from "@/lib/agent/composition/project-effective-composition"
import type { EffectiveValue } from "@/lib/config/effective-value"
import type {
  PluginBotCompositionRequestV1,
  PluginBotExecutor,
  PluginBotPolicyV1,
} from "@/types/plugin/plugin-bot"

/** Which layer supplied a composition axis. */
export type BotCompositionSource =
  "run-request" | "installation" | "definition" | "policy-ceiling" | "system-default"

export type BotComposition = ProjectedComposition<BotCompositionSource>

/** Layers, nearest the run first. Order IS the precedence. */
const COMPOSITION_PRECEDENCE = ["run-request", "installation", "definition"] as const

export interface ProjectBotCompositionInput {
  executor: PluginBotExecutor
  /** Team or workflow id the executor names, carried onto `orchestrationRef`. */
  executorRef?: string
  definition?: PluginBotCompositionRequestV1
  installation?: PluginBotCompositionRequestV1
  request?: PluginBotCompositionRequestV1
  /** The already-intersected ceiling from `resolveBotPolicy`. */
  policy?: PluginBotPolicyV1
  /** Preset ids that count as known. A stranger falls back to Standard. */
  knownPresetIds?: ReadonlySet<string>
  runtimeBindingRef?: string
}

/**
 * A Bot's executor decides how it orchestrates. `handler` is `direct` because
 * the handler IS the orchestration: whatever it fans out to, it does through
 * the same APIs any caller would.
 */
export function orchestrationForExecutor(executor: PluginBotExecutor): AgentOrchestrationPolicy {
  switch (executor) {
    case "workflow":
      return "workflow"
    case "squad":
      return "team"
    case "agent-turn":
    case "handler":
      return "direct"
  }
}

function pick<K extends keyof PluginBotCompositionRequestV1>(
  input: ProjectBotCompositionInput,
  key: K
): { value: PluginBotCompositionRequestV1[K]; source: BotCompositionSource } {
  const layers: Record<
    (typeof COMPOSITION_PRECEDENCE)[number],
    PluginBotCompositionRequestV1 | undefined
  > = {
    "run-request": input.request,
    installation: input.installation,
    definition: input.definition,
  }
  for (const source of COMPOSITION_PRECEDENCE) {
    const value = layers[source]?.[key]
    if (value !== undefined) return { value, source }
  }
  return { value: undefined, source: "system-default" }
}

export function projectBotComposition(input: ProjectBotCompositionInput): BotComposition {
  const policy = input.policy ?? {}

  const presetPick = pick(input, "presetId")
  const known = input.knownPresetIds
  const presetId =
    presetPick.value && (!known || known.has(presetPick.value))
      ? presetPick.value
      : STANDARD_PRESET_ID
  const presetSource: BotCompositionSource =
    presetId === presetPick.value ? presetPick.source : "system-default"

  // Autonomy first: it is also an authority ceiling, and resolving authority
  // against a not-yet-narrowed autonomy would let the pair disagree.
  const autonomyPick = pick(input, "autonomy")
  const autonomyRequested = autonomyPick.value
  const autonomyEffective: AutonomyLevel =
    policy.maxAutonomy !== undefined
      ? narrowAutonomy(policy.maxAutonomy, autonomyRequested)
      : (autonomyRequested ?? "confirm")
  const autonomy: EffectiveValue<AutonomyLevel, BotCompositionSource> = {
    requested: autonomyRequested,
    effective: autonomyEffective,
    source:
      autonomyRequested === undefined
        ? policy.maxAutonomy !== undefined
          ? "policy-ceiling"
          : "system-default"
        : autonomyEffective === autonomyRequested
          ? autonomyPick.source
          : "policy-ceiling",
    ...(autonomyRequested !== undefined && autonomyEffective !== autonomyRequested
      ? { blockedReason: "narrowed_by_policy" }
      : {}),
  }

  const authorityPick = pick(input, "authority")
  const authorityRequested = authorityPick.value
  const authorityEffective: AgentAuthority | undefined =
    policy.maxAuthority !== undefined
      ? (narrowAuthority(policy.maxAuthority, authorityRequested) as AgentAuthority)
      : authorityRequested
  const authority: EffectiveValue<AgentAuthority | undefined, BotCompositionSource> = {
    requested: authorityRequested,
    effective: authorityEffective,
    source:
      authorityEffective === undefined
        ? "system-default"
        : authorityRequested === undefined
          ? "policy-ceiling"
          : authorityEffective === authorityRequested
            ? authorityPick.source
            : "policy-ceiling",
    ...(authorityRequested !== undefined && authorityEffective !== authorityRequested
      ? { blockedReason: "narrowed_by_policy" }
      : {}),
  }

  const engagementPick = pick(input, "engagement")
  // A Bot run has nobody watching it type. `background` is the honest default,
  // and `inline` only makes sense when a person is already in the conversation.
  const engagement: EffectiveValue<EngagementMode, BotCompositionSource> = {
    requested: engagementPick.value,
    effective: engagementPick.value ?? "background",
    source: engagementPick.value === undefined ? "system-default" : engagementPick.source,
  }

  return projectEffectiveComposition<BotCompositionSource>({
    base: { presetId },
    presetSource,
    orchestration: {
      policy: orchestrationForExecutor(input.executor),
      ...(input.executorRef ? { ref: input.executorRef } : {}),
      source: "definition",
    },
    engagement,
    autonomy,
    authority,
    ...(input.runtimeBindingRef ? { runtimeBindingRef: input.runtimeBindingRef } : {}),
  })
}
