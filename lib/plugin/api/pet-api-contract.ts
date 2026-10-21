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
} from "@/lib/pet/access/limits"
import type { PluginEmittablePetEventKind } from "@cognia/plugin-contract/lib/plugin/api/pet-api-contract"
export type {
  PluginEmittablePetEventKind,
  PluginPetAvailability,
  PluginPetEvent,
  PluginPetUnavailableReason,
} from "@cognia/plugin-contract/lib/plugin/api/pet-api-contract"

/** Kinds a plugin may emit through `emitEvent`, nurture and neutral only. */
export const PLUGIN_EMITTABLE_PET_EVENT_KINDS: readonly PluginEmittablePetEventKind[] =
  PET_REWARDABLE_KINDS

/** Hard per-call XP ceiling, below the daily budget. */
export const MAX_XP_PER_EMIT = MAX_XP_PER_REWARD

/** Hard per-call coin ceiling, below the daily budget. */
export const MAX_COINS_PER_EMIT = MAX_COINS_PER_REWARD

export class PetEventKindNotAllowedError extends Error {
  constructor(kind: string) {
    super(
      `Pet event kind "${kind}" is not plugin-emittable. Allowed: ${PLUGIN_EMITTABLE_PET_EVENT_KINDS.join(", ")}`
    )
    this.name = "PetEventKindNotAllowedError"
  }
}

/**
 * Thrown when a plugin names an item it does not own (or one that is not a
 * consumable). `applyPetEvent` applies the named item's stronger `needsEffect`
 * in place of the base restore, so before the access gate an unowned id was a
 * free upgrade: the shop path checked ownership and decremented stock, this
 * path did neither.
 */
export class PetItemNotOwnedError extends Error {
  constructor(itemId: string) {
    super(`Pet item "${itemId}" is not owned, or is not a consumable.`)
    this.name = "PetItemNotOwnedError"
  }
}

/**
 * Thrown when an item is used for an interaction it is not for (a food item
 * on `petted`). The item is not spent.
 */
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

/**
 * Thrown when the pet is still recovering from the same action: the host
 * would drop it, so nothing was spent (no budget, no item). Retry after
 * `retryAfterMs`.
 */
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
