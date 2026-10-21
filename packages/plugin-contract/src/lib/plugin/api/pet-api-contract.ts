/**
 * The plugin contract's share of `lib/plugin/api/pet-api-contract.ts`, which re-exports these.
 */
import type { PetEventKind, PetEventSource } from "@/types/pet"
import type { PetRewardableKind } from "../../pet/access/limits"

/**
 * Kinds a plugin may emit through `emitEvent`: the seven care actions, the
 * legacy `workflowRun`, and `pluginReward` — the neutral kind for a reward
 * (a finished quest, a reached milestone) that is not a workflow run, a goal
 * or a care action and so feeds no counter, achievement or stat.
 */
export type PluginEmittablePetEventKind = PetRewardableKind

/**
 * Why the pet cannot be driven right now. `missing-capability` is this
 * plugin's own manifest; the rest describe the host and the pet itself.
 */
export type PluginPetUnavailableReason =
  | "missing-capability"
  | "disabled"
  | "unsupported-host"
  | "secondary-window"
  | "uninitialized"
  | "not-hatched"

/** Whether interactions and rewards would reach the pet right now. */
export type PluginPetAvailability =
  { available: true } | { available: false; reason: PluginPetUnavailableReason }

/** Sanitized event forwarded to plugin subscribers. */
export interface PluginPetEvent {
  source: PetEventSource
  kind: PetEventKind
  xp?: number
  /** Reduced meta — id-shaped keys only; free-form text never crosses. */
  meta?: {
    achievementId?: string
    itemId?: string
    goalId?: string
    level?: number
    stage?: string
  }
  at: number
}
