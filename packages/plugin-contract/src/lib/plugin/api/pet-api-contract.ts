// The dependency-free half of the plugin pet API (ctx.pet): the kinds a
// plugin may emit, the per-call limits, the availability vocabulary, the
// sanitized event shape, and the errors a refused call throws.
//
// `pet-api.ts` implements ctx.pet and re-exports all of this; the plugin SDK
// publishes it as `@cognia/plugin-sdk/api/pet` so authors can `instanceof` an
// error or size a reward without importing host code. Nothing here may import
// the settings store, Dexie, or the event bus.

import {
  MAX_COINS_PER_REWARD,
  MAX_XP_PER_REWARD,
  PET_REWARDABLE_KINDS,
} from "../../pet/access/limits"
import type { PetEventKind, PetEventSource } from "../../../types/pet"
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

export const PLUGIN_EMITTABLE_PET_EVENT_KINDS: readonly PluginEmittablePetEventKind[] =
  PET_REWARDABLE_KINDS

export const MAX_XP_PER_EMIT = MAX_XP_PER_REWARD

export const MAX_COINS_PER_EMIT = MAX_COINS_PER_REWARD

export class PetEventKindNotAllowedError extends Error {
  constructor(kind: string) {
    super(
      `Pet event kind "${kind}" is not plugin-emittable. Allowed: ${PLUGIN_EMITTABLE_PET_EVENT_KINDS.join(", ")}`
    )
    this.name = "PetEventKindNotAllowedError"
  }
}

export class PetItemNotOwnedError extends Error {
  constructor(itemId: string) {
    super(`Pet item "${itemId}" is not owned, or is not a consumable.`)
    this.name = "PetItemNotOwnedError"
  }
}

export class PetItemKindMismatchError extends Error {
  readonly itemId: string
  readonly kind: string
  readonly itemKind: string | undefined
  constructor(itemId: string, kind: string, itemKind: string | undefined) {
    super(
      `Pet item "${itemId}" is used for "${itemKind ?? "nothing"}", not "${kind}". It was not spent.`
    )
    this.name = "PetItemKindMismatchError"
    this.itemId = itemId
    this.kind = kind
    this.itemKind = itemKind
  }
}

export class PetCooldownError extends Error {
  readonly kind: string
  readonly retryAfterMs: number
  constructor(kind: string, retryAfterMs: number) {
    super(
      `The pet is still recovering from "${kind}"; nothing was spent. Retry in ${Math.ceil(retryAfterMs / 1000)}s.`
    )
    this.name = "PetCooldownError"
    this.kind = kind
    this.retryAfterMs = retryAfterMs
  }
}
