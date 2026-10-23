import type {
  AgentModelRoleOverrides,
  ExternalAgentCogniaModelBinding,
} from "@cognia/agent-contracts/model-binding"
import { contentDigest } from "@cognia/agent"
import type { AgentModelSlotDescriptor } from "./model-slots"

type ModelPlanSource = "call" | "subagent" | "config"

export interface TaskModelPlan {
  version: 2 | 3
  primaryModelId: string
  slots: Record<
    string,
    { modelId: string; reasoningEffort?: string; variant?: string; source: ModelPlanSource }
  >
  models: string[]
  allowedSpawnModels?: string[]
  fingerprint: string
}

/** Why a set of slot overrides cannot run; `slot` names the offending slot. */
export type TaskModelPlanRefusal =
  | "unsupported-slot"
  | "cross-provider-unsupported"
  | "cross-account-unsupported"
  | "effort-unsupported"
  | "too-many-models"
  | "spawn-models-unsupported"
  | "default-spawn-model-not-allowed"

export type TaskModelPlanResult =
  { ok: true; plan: TaskModelPlan } | { ok: false; reason: TaskModelPlanRefusal; slot?: string }

/** Merge highest-precedence layers slot by slot, preserving explicit inheritance. */
/**
 * Whether a configuration's sub-task models apply to a turn. They were chosen
 * on the configuration's own provider account, so a turn the caller moved to
 * another provider or account runs on its primary alone instead of being
 * refused for choices it never made. A configuration that names no account
 * follows whichever one its primary runs on, including the account a lease
 * resolved and a later turn passes back, so every turn of a task agrees.
 * `override` is the caller's binding, absent when the turn follows the config.
 */
export function configModelRolesApply(
  configBinding: ExternalAgentCogniaModelBinding | null | undefined,
  override: ExternalAgentCogniaModelBinding | null | undefined
): boolean {
  if (!configBinding) return false
  if (!override) return true
  return (
    override.providerId === configBinding.providerId &&
    (configBinding.accountId === undefined || override.accountId === configBinding.accountId)
  )
}

export function mergeModelRoleLayers(
  ...layers: readonly (AgentModelRoleOverrides | undefined)[]
): AgentModelRoleOverrides | undefined {
  if (!layers.some((layer) => layer !== undefined)) return undefined
  const slots: Record<string, AgentModelRoleOverrides["slots"][string]> = {}
  for (const layer of layers) {
    for (const [id, selection] of Object.entries(layer?.slots ?? {})) {
      if (!Object.hasOwn(slots, id)) slots[id] = structuredClone(selection)
    }
  }
  const policy = layers.find(
    (layer) => layer?.version === 2 && layer.allowedSpawnModels !== undefined
  )
  return policy?.version === 2
    ? { version: 2, slots, allowedSpawnModels: structuredClone(policy.allowedSpawnModels) }
    : { version: 1, slots }
}

/**
 * Compile normalized gateway bindings, highest-precedence layer first. Every
 * layer's slot IDs must be supported, including shadowed stored overrides.
 * Provider, account and effort checks apply only to each winning selection;
 * inherit-primary stops lookup and never inherits a lower selection's effort.
 * Unnamed slots stay absent to preserve the runtime's legacy projection.
 */
export function compileTaskModelPlan(input: {
  primary: ExternalAgentCogniaModelBinding
  slots: readonly AgentModelSlotDescriptor[]
  layers: readonly { source: ModelPlanSource; overrides?: AgentModelRoleOverrides }[]
  /** Explicit native agent definitions, validated before the gateway lease is minted. */
  explicitModels?: Readonly<Record<string, ExternalAgentCogniaModelBinding & { variant?: string }>>
  modelSupportsReasoning?: (modelId: string) => boolean | undefined
  /**
   * The efforts a model itself accepts (e.g. GPT-6 rejects `minimal`), as the
   * app's reasoning-tier tables say. `undefined` leaves only the slot's ladder.
   */
  modelEffortValues?: (modelId: string) => readonly string[] | undefined
}): TaskModelPlanResult {
  const { primary, layers } = input
  const descriptors = new Map<string, AgentModelSlotDescriptor>(
    input.slots.map((slot) => [slot.id, slot])
  )
  const namedSlots = new Set<string>()
  for (const layer of layers) {
    for (const id of Object.keys(layer.overrides?.slots ?? {})) {
      if (!descriptors.has(id)) return { ok: false, reason: "unsupported-slot", slot: id }
      namedSlots.add(id)
    }
  }

  const slots: TaskModelPlan["slots"] = {}
  const models = new Set([primary.modelId])
  for (const id of [...namedSlots].sort()) {
    for (const layer of layers) {
      if (!layer.overrides || !Object.hasOwn(layer.overrides.slots, id)) continue
      const selection = layer.overrides.slots[id]
      let modelId = primary.modelId
      let reasoningEffort: string | undefined
      if (selection.kind === "cognia") {
        const binding = selection.binding
        if (binding.providerId !== primary.providerId)
          return { ok: false, reason: "cross-provider-unsupported", slot: id }
        if (binding.accountId !== undefined && binding.accountId !== primary.accountId)
          return { ok: false, reason: "cross-account-unsupported", slot: id }
        modelId = binding.modelId
        reasoningEffort = selection.reasoningEffort
        if (
          reasoningEffort !== undefined &&
          (!descriptors.get(id)?.reasoningEfforts?.includes(reasoningEffort) ||
            input.modelSupportsReasoning?.(modelId) === false ||
            input.modelEffortValues?.(modelId)?.includes(reasoningEffort) === false)
        )
          return { ok: false, reason: "effort-unsupported", slot: id }
      }
      slots[id] = {
        modelId,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        source: layer.source,
      }
      models.add(modelId)
      if (models.size > 32) return { ok: false, reason: "too-many-models", slot: id }
      break
    }
  }

  for (const id of Object.keys(input.explicitModels ?? {}).sort()) {
    const binding = input.explicitModels![id]
    if (binding.providerId !== primary.providerId)
      return { ok: false, reason: "cross-provider-unsupported", slot: id }
    if (binding.accountId !== undefined && binding.accountId !== primary.accountId)
      return { ok: false, reason: "cross-account-unsupported", slot: id }
    slots[id] = {
      modelId: binding.modelId,
      ...(binding.variant !== undefined ? { variant: binding.variant } : {}),
      source: "config",
    }
    models.add(binding.modelId)
    if (models.size > 32) return { ok: false, reason: "too-many-models", slot: id }
  }

  const policy = layers.find(
    (layer) => layer.overrides?.version === 2 && layer.overrides.allowedSpawnModels !== undefined
  )?.overrides
  let allowedSpawnModels: string[] | undefined
  if (policy?.version === 2 && policy.allowedSpawnModels !== undefined) {
    if (!input.slots.some((slot) => slot.supportsSpawnModelOverrides))
      return { ok: false, reason: "spawn-models-unsupported" }
    const candidates = new Set<string>()
    for (const binding of policy.allowedSpawnModels) {
      if (binding.providerId !== primary.providerId)
        return { ok: false, reason: "cross-provider-unsupported" }
      if (binding.accountId !== undefined && binding.accountId !== primary.accountId)
        return { ok: false, reason: "cross-account-unsupported" }
      candidates.add(binding.modelId)
      models.add(binding.modelId)
    }
    if (models.size > 32) return { ok: false, reason: "too-many-models" }
    if (candidates.size && !candidates.has(slots["subagent.default"]?.modelId ?? primary.modelId))
      return { ok: false, reason: "default-spawn-model-not-allowed" }
    allowedSpawnModels = [...candidates].sort()
  }
  const version = allowedSpawnModels !== undefined ? 3 : 2
  return {
    ok: true,
    plan: {
      version,
      primaryModelId: primary.modelId,
      slots,
      models: [...models],
      ...(allowedSpawnModels !== undefined ? { allowedSpawnModels } : {}),
      fingerprint: contentDigest({
        version,
        ...(allowedSpawnModels !== undefined ? { allowedSpawnModels } : {}),
        primaryModelId: primary.modelId,
        providerId: primary.providerId,
        accountId: primary.accountId,
        slots: Object.fromEntries(
          Object.entries(slots).map(([id, { modelId, reasoningEffort, variant }]) => [
            id,
            { modelId, reasoningEffort, ...(variant !== undefined ? { variant } : {}) },
          ])
        ),
      }),
    },
  }
}
