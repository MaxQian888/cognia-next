import type { DispatchRuleHit, RoutingSource } from "@/lib/connectors/dispatch-rules"
import { resolveEffectiveRouting } from "@/lib/connectors/dispatch-rules"
import {
  resolveImHostCapabilities,
  resolveRequireHitlForWrites,
} from "@/lib/connectors/permission-resolve"
import { projectStoredMode, type ImTargetKind } from "@/lib/connectors/composition/mode-projection"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import type {
  AgentAuthority,
  AutonomyLevel,
  EngagementMode,
} from "@cognia/agent-config-types/agent-composition"
import type {
  ActiveRunDispatchMode,
  ConnectorMode,
  InboundActivationPolicy,
} from "@/types/connectors/policy"

export type ImConfigSource =
  | "conversation-override"
  /**
   * The value lives on the conversation override row but was written by an
   * assignment (`setAssignee`, slice 1A) rather than an explicit routing edit.
   */
  | "assignment"
  /**
   * The value was forced by an SLA escalation step rather than chosen. Without
   * this label the ladder silently rewriting a conversation's mode is
   * indistinguishable from an operator edit in every UI.
   */
  | "escalation"
  /**
   * The value came from the bound ChatSession. Real for provider/model: the
   * send path reads `session.model` between the conversation override and the
   * bot default, so omitting the layer here made `/status` report a model the
   * send would not use.
   */
  | "session"
  | "dispatch-rule"
  | "adapter-default"
  | "system-default"
  | "target-managed"

export interface EffectiveConfigValue<T> {
  requested: T | undefined
  effective: T
  source: ImConfigSource
  blockedReason?: string
}

export type ImExecutionTarget =
  { kind: "direct" } | { kind: "team"; id: string } | { kind: "workflow"; id: string }

function sourceOf(source: RoutingSource): ImConfigSource {
  if (source === "override") return "conversation-override"
  if (source === "assignment") return "assignment"
  if (source === "rule") return "dispatch-rule"
  if (source === "instance-default") return "adapter-default"
  return "system-default"
}

/**
 * Canonical, side-effect-free IM effective configuration facade. Runtime,
 * settings, `/status`, and control commands consume this projection so value
 * precedence and source labels cannot drift.
 */
export function resolveImEffectiveConfig(input: {
  adapter: AdapterInstanceRow
  override: ConversationOverrideRow | null
  rule: DispatchRuleHit | null
  system: { mode: ConnectorMode; characterId?: string }
  /**
   * The conversation's active ChatSession, when the caller has one resolved.
   * Optional so every existing call site keeps today's behaviour; passing it
   * is what makes the reported provider/model match what `resolveSendOptions`
   * will actually send.
   */
  session?: { model?: string; providerOverride?: string }
  characterComputerUseEnabled?: boolean
  references?: {
    teamExists?: boolean
    workflowExecutable?: boolean
    characterExists?: boolean
  }
}) {
  const { adapter, override, rule, system, session, references } = input
  const routing = resolveEffectiveRouting(adapter, override, rule)
  const effectiveCharacterId = override?.characterDisabled
    ? undefined
    : (routing.characterId ?? system.characterId)

  let target: EffectiveConfigValue<ImExecutionTarget>
  if (routing.teamId) {
    target = {
      requested: override?.teamId ? { kind: "team", id: override.teamId } : undefined,
      effective: { kind: "team", id: routing.teamId },
      source: sourceOf(routing.teamSource),
      ...(references?.teamExists === false ? { blockedReason: "team_reference_missing" } : {}),
    }
  } else if (routing.workflowId) {
    target = {
      requested: override?.workflowId ? { kind: "workflow", id: override.workflowId } : undefined,
      effective: { kind: "workflow", id: routing.workflowId },
      source: sourceOf(routing.workflowSource),
      ...(references?.workflowExecutable === false
        ? { blockedReason: "workflow_not_deployed" }
        : {}),
    }
  } else {
    target = {
      requested:
        override?.teamDisabled || override?.workflowDisabled ? { kind: "direct" } : undefined,
      effective: { kind: "direct" },
      source:
        override?.teamDisabled || override?.workflowDisabled
          ? "conversation-override"
          : "system-default",
    }
  }

  const character: EffectiveConfigValue<string | undefined> = {
    requested: override?.characterDisabled ? undefined : override?.characterId,
    effective: effectiveCharacterId,
    source: override?.characterDisabled
      ? "conversation-override"
      : routing.characterId
        ? sourceOf(routing.characterSource)
        : system.characterId
          ? "system-default"
          : "system-default",
    ...(effectiveCharacterId && references?.characterExists === false
      ? { blockedReason: "character_reference_missing" }
      : {}),
  }

  const targetManaged = target.effective.kind !== "direct"
  // The session layer is not decoration: `resolveSendOptions` reads
  // `session.model` between the conversation override and the bot default, so
  // a facade that skips it reports a model the send will not use.
  const provider: EffectiveConfigValue<string | undefined> = {
    requested: override?.providerOverride,
    effective: targetManaged
      ? undefined
      : (override?.providerOverride ?? session?.providerOverride ?? adapter.defaultProvider),
    source: targetManaged
      ? "target-managed"
      : override?.providerOverride
        ? "conversation-override"
        : session?.providerOverride
          ? "session"
          : adapter.defaultProvider
            ? "adapter-default"
            : "system-default",
    ...(targetManaged ? { blockedReason: "managed_by_target" } : {}),
  }
  const model: EffectiveConfigValue<string | undefined> = {
    requested: override?.modelOverride,
    effective: targetManaged
      ? undefined
      : (override?.modelOverride ?? session?.model ?? adapter.defaultModel),
    source: targetManaged
      ? "target-managed"
      : override?.modelOverride
        ? "conversation-override"
        : session?.model
          ? "session"
          : adapter.defaultModel
            ? "adapter-default"
            : "system-default",
    ...(targetManaged ? { blockedReason: "managed_by_target" } : {}),
  }

  // Declared, not inferred: without a contextual type each `source:` ternary
  // widens from the `ImConfigSource` literals to plain `string`, which the
  // consumers (`conversation-override-dialog.tsx`) then cannot accept. `mode`
  // and `target` already avoid this by going through typed locals.
  const behavior: {
    inboundActivationPolicy: EffectiveConfigValue<InboundActivationPolicy>
    activeRunDispatchMode: EffectiveConfigValue<ActiveRunDispatchMode>
    activationTtlMs: EffectiveConfigValue<number | undefined>
  } = {
    inboundActivationPolicy: {
      requested: override?.inboundActivationPolicy,
      effective:
        override?.inboundActivationPolicy ?? adapter.inboundActivationPolicy ?? "mention_activates",
      source:
        override?.inboundActivationPolicy !== undefined
          ? "conversation-override"
          : adapter.inboundActivationPolicy !== undefined
            ? "adapter-default"
            : "system-default",
    },
    activeRunDispatchMode: {
      requested: override?.activeRunDispatchMode,
      effective: override?.activeRunDispatchMode ?? adapter.activeRunDispatchMode ?? "queue",
      source:
        override?.activeRunDispatchMode !== undefined
          ? "conversation-override"
          : adapter.activeRunDispatchMode !== undefined
            ? "adapter-default"
            : "system-default",
    },
    activationTtlMs: {
      requested: override?.activationTtlMs,
      effective: override?.activationTtlMs ?? adapter.activationTtlMs,
      source:
        override?.activationTtlMs !== undefined
          ? "conversation-override"
          : adapter.activationTtlMs !== undefined
            ? "adapter-default"
            : "system-default",
    },
  }

  // --- composed-mode axes (ADR-0117) ---------------------------------------
  // Derived from the axis fields when a row has them and from the legacy pair
  // otherwise, so no backfill is owed. `mode` below stays as the compat
  // mirror; these are what consumers should read.
  const projected = projectStoredMode({
    mode: override?.mode ?? system.mode,
    targetKind: target.effective.kind as ImTargetKind,
    autonomy: override?.autonomy ?? adapter.defaultAutonomy,
    engagement: override?.engagement ?? adapter.defaultEngagement,
    approvalMode: override?.approvalMode,
    authority: override?.authority ?? adapter.defaultAuthority,
  })

  const modeSource: ImConfigSource =
    override?.modeForcedBy === "escalation"
      ? "escalation"
      : override?.mode
        ? override.assignmentPreviousMode !== undefined
          ? "assignment"
          : "conversation-override"
        : "adapter-default"

  function axisSource(
    fromOverride: unknown,
    fromAdapter: unknown,
    fallback: ImConfigSource
  ): ImConfigSource {
    if (fromOverride !== undefined)
      return modeSource === "escalation" ? "escalation" : "conversation-override"
    if (fromAdapter !== undefined) return "adapter-default"
    return fallback
  }

  const autonomy: EffectiveConfigValue<AutonomyLevel> = {
    requested: override?.autonomy,
    effective: projected.autonomy,
    // An axis value that was never written derives from `mode`, so it inherits
    // `mode`'s provenance rather than claiming a default nobody chose.
    source: axisSource(override?.autonomy, adapter.defaultAutonomy, modeSource),
  }
  const engagement: EffectiveConfigValue<EngagementMode> = {
    requested: override?.engagement,
    effective: projected.engagement,
    // Engagement follows the target when it is not explicitly set, so an
    // unset value is sourced where the target came from.
    source:
      override?.engagement !== undefined
        ? "conversation-override"
        : adapter.defaultEngagement !== undefined
          ? "adapter-default"
          : projected.engagement === "human"
            ? modeSource
            : target.source,
  }
  const authority: EffectiveConfigValue<AgentAuthority | undefined> = {
    requested: override?.authority,
    effective: projected.authority,
    source: axisSource(
      override?.authority ?? override?.approvalMode,
      adapter.defaultAuthority,
      "system-default"
    ),
  }

  return {
    routing,
    target,
    character,
    autonomy,
    engagement,
    authority,
    mode: {
      requested: override?.mode,
      effective: override?.mode ?? system.mode,
      // Kept as the compat mirror of `autonomy` + `engagement`. A human
      // assignment forces `mode = "manual"` and remembers the prior mode in
      // `assignmentPreviousMode` (slice 1A); an SLA step sets `modeForcedBy`.
      // Both are labelled so the chip can say who changed it.
      source: modeSource,
    } satisfies EffectiveConfigValue<ConnectorMode>,
    behavior: behavior,
    provider,
    model,
    permissions: {
      builtInSkillCeiling: {
        requested: override?.allowedBuiltInSkillIds,
        effective: {
          adapter: adapter.builtInSkillCeiling,
          conversation: override?.allowedBuiltInSkillIds,
        },
        source:
          override?.allowedBuiltInSkillIds !== undefined
            ? "conversation-override"
            : adapter.builtInSkillCeiling !== undefined
              ? "adapter-default"
              : "system-default",
      },
      hostCapabilities: resolveImHostCapabilities({
        adapter,
        override,
        characterComputerUseEnabled: input.characterComputerUseEnabled,
      }),
      requireHitlForWrites: {
        requested: override?.requireHitlForWrites,
        effective: resolveRequireHitlForWrites(adapter, override),
        source:
          override?.requireHitlForWrites !== undefined
            ? "conversation-override"
            : adapter.requireHitlForWrites !== undefined
              ? "adapter-default"
              : "system-default",
      } satisfies EffectiveConfigValue<boolean>,
    },
  }
}
