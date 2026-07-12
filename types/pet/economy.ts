// Economy domain: the coin balance, daily-care streak, item inventory, and
// shop catalog shapes. Coins/streak live as optional non-indexed fields on the
// `PetProfile` singleton (legacy-normalize pattern like `care`/`statProgress`);
// owned items live in the dedicated `petInventory` Dexie table. The catalog
// itself is static code (`lib/pet/economy/item-catalog.ts`), never persisted.

import type { PetCosmeticOverride } from "./bones"
import type { PetNeedKind } from "./needs"

/** Daily-care streak cache. `lastDay` is a LOCAL calendar day key (YYYY-MM-DD)
 *  so "came back the next day" follows the user's wall clock, not UTC. */
export interface PetStreak {
  /** Consecutive local days with ≥1 direct user interaction. */
  days: number
  /** Local day key of the most recent counted interaction; null = never. */
  lastDay: string | null
}

export const DEFAULT_STREAK: PetStreak = { days: 0, lastDay: null }

/** Fill missing/invalid streak fields (legacy rows predate the economy). */
export function normalizeStreak(s?: Partial<PetStreak> | null): PetStreak {
  const days =
    typeof s?.days === "number" && Number.isFinite(s.days) ? Math.max(0, Math.floor(s.days)) : 0
  const lastDay = typeof s?.lastDay === "string" && s.lastDay.length > 0 ? s.lastDay : null
  return { days, lastDay }
}

/** Coin balance: finite, non-negative integer; absent/garbage = 0. */
export function normalizeCoins(v?: number | null): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0
}

/** One owned-item row in the `petInventory` Dexie table (PK = item id). */
export interface PetInventoryRow {
  /** Catalog item id (`lib/pet/economy/item-catalog.ts`). */
  id: string
  /** Owned quantity (> 0 — rows are deleted at 0). */
  qty: number
  /** Epoch ms of the first acquisition. */
  acquiredAt: number
  /** Epoch ms of the last quantity change. */
  updatedAt: number
}

/** Shop grouping. Plugin manifests stay restricted to the original three
 *  (`types/plugin/plugin-pet.ts`); `care` is host-catalog-only for the
 *  sleep/clean/treat consumables. */
export type PetItemCategory = "food" | "toy" | "care" | "decor"

/** A purchasable catalog item. Consumables emit their `interactionKind` event
 *  with `meta.itemId` on use so the whole progression path (XP, one-shots,
 *  achievements) stays owned by the pet controller; `needsEffect` overrides
 *  the base `INTERACTION_EFFECTS` restore for that event. Decor applies its
 *  `cosmetic` override to the profile and is never consumed. */
export interface PetShopItem {
  id: string
  /** i18n leaf: `pet.shop.items.<i18nKey>.{title,description}`. */
  i18nKey: string
  /** Lucide icon name, resolved by the shop UI like achievement icons. */
  icon: string
  category: PetItemCategory
  /** Price in coins (> 0). */
  price: number
  /** True for food/toys (quantity decremented on use). */
  consumable: boolean
  /** Event kind emitted when a consumable is used. */
  interactionKind?: "fed" | "played" | "petted" | "talked" | "slept" | "cleaned" | "treated"
  /** Differentiated needs restore; overrides the interaction's base effect. */
  needsEffect?: Partial<Record<PetNeedKind, number>>
  /** Decor: cosmetic override applied to the profile on use. */
  cosmetic?: PetCosmeticOverride
}
