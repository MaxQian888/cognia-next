/**
 * A Cognia provider/model an external agent runs on through the local gateway
 * (ADR-0090, 2026-09-11 amendment). Nonsecret: the upstream credential stays
 * in Cognia and reaches the task through its gateway lease.
 *
 * An omitted provider-account selection means the provider default at task start; a concrete id
 * pins the task to that subscription account; `null` selects the manual API
 * settings.
 */
export interface ExternalAgentCogniaModelBinding {
  providerId: string
  modelId: string
  accountId?: string | null
}

/**
 * What one model slot of an external agent task runs on.
 *
 * `inherit-primary` explicitly follows the task's primary model and stops a
 * lower layer's selection for that slot from applying. `cognia` names another
 * gateway model; it must share the primary binding's provider and account
 * (an omitted `accountId` follows the primary's account). `reasoningEffort`
 * is accepted only on slots that declare effort support.
 *
 * Only the Cognia gateway lane projects slots; a configuration on its own
 * native provider settings ignores them (the editors show why).
 */
export type AgentModelSlotSelection =
  | { kind: "inherit-primary" }
  | {
      kind: "cognia"
      binding: ExternalAgentCogniaModelBinding
      reasoningEffort?: string
    }

/**
 * Per-slot model overrides for an external agent task: `subagent.default`,
 * `tier.haiku|sonnet|opus`, `aux.<name>`. The slots a runtime accepts are
 * declared beside its gateway projector
 * (`lib/ai/agent/external/config/model-slots.ts`). Nonsecret.
 *
 * Layers (per-call, subagent template, configuration) merge slot by slot; a
 * slot absent from a layer inherits the next one, and a slot absent
 * everywhere keeps the runtime's historical single-model behaviour.
 */
export type AgentModelRoleOverrides =
  | { version: 1; slots: Readonly<Record<string, AgentModelSlotSelection>> }
  | {
      version: 2
      slots: Readonly<Record<string, AgentModelSlotSelection>>
      /** Highest explicitly supplied layer replaces candidates; [] clears extras. */
      allowedSpawnModels?: readonly ExternalAgentCogniaModelBinding[]
    }
