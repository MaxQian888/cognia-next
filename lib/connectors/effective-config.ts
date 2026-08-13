import type { DispatchRuleMatch } from "@/lib/connectors/dispatch-rules"
import { resolveEffectiveRouting } from "@/lib/connectors/dispatch-rules"
import {
  resolveImHostCapabilities,
  resolveRequireHitlForWrites,
} from "@/lib/connectors/permission-resolve"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import type { ConnectorMode } from "@/types/connectors/policy"

export type ImConfigSource =
  | "conversation-override"
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

function sourceOf(source: "override" | "rule" | "instance-default" | "none"): ImConfigSource {
  if (source === "override") return "conversation-override"
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
  rule: DispatchRuleMatch | null
  system: { mode: ConnectorMode; characterId?: string }
  characterComputerUseEnabled?: boolean
  references?: {
    teamExists?: boolean
    workflowExecutable?: boolean
    characterExists?: boolean
  }
}) {
  const { adapter, override, rule, system, references } = input
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
  const provider: EffectiveConfigValue<string | undefined> = {
    requested: override?.providerOverride,
    effective: targetManaged ? undefined : (override?.providerOverride ?? adapter.defaultProvider),
    source: targetManaged
      ? "target-managed"
      : override?.providerOverride
        ? "conversation-override"
        : adapter.defaultProvider
          ? "adapter-default"
          : "system-default",
    ...(targetManaged ? { blockedReason: "managed_by_target" } : {}),
  }
  const model: EffectiveConfigValue<string | undefined> = {
    requested: override?.modelOverride,
    effective: targetManaged ? undefined : (override?.modelOverride ?? adapter.defaultModel),
    source: targetManaged
      ? "target-managed"
      : override?.modelOverride
        ? "conversation-override"
        : adapter.defaultModel
          ? "adapter-default"
          : "system-default",
    ...(targetManaged ? { blockedReason: "managed_by_target" } : {}),
  }

  return {
    routing,
    target,
    character,
    mode: {
      requested: override?.mode,
      effective: override?.mode ?? system.mode,
      source: override?.mode ? "conversation-override" : "adapter-default",
    } satisfies EffectiveConfigValue<ConnectorMode>,
    behavior: {
      inboundActivationPolicy: {
        requested: override?.inboundActivationPolicy,
        effective:
          override?.inboundActivationPolicy ??
          adapter.inboundActivationPolicy ??
          "mention_activates",
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
    },
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
