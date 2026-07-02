// Static shop catalog — the economy sibling of `lib/pet/achievements/registry.ts`.
// Definitions live in code; only ownership (`petInventory`) is persisted.
// Plugin-contributed items are unioned in via the overlay registry once the
// plugin integration lands (static-first, overlay-fallback).

import type { PetShopItem } from "@/types/pet"

export const PET_ITEMS: PetShopItem[] = [
  // ── Food (consumable → "fed") ──────────────────────────────────────────────
  {
    id: "berry",
    i18nKey: "berry",
    icon: "Cherry",
    category: "food",
    price: 5,
    consumable: true,
    interactionKind: "fed",
    needsEffect: { energy: 15, mood: 8 },
  },
  {
    id: "royal-feast",
    i18nKey: "royalFeast",
    icon: "UtensilsCrossed",
    category: "food",
    price: 25,
    consumable: true,
    interactionKind: "fed",
    needsEffect: { energy: 45, mood: 10, bond: 2 },
  },
  // ── Toys (consumable → "played") ───────────────────────────────────────────
  {
    id: "yarn-ball",
    i18nKey: "yarnBall",
    icon: "Volleyball",
    category: "toy",
    price: 8,
    consumable: true,
    interactionKind: "played",
    needsEffect: { mood: 30, energy: -4, bond: 6 },
  },
  {
    id: "puzzle-cube",
    i18nKey: "puzzleCube",
    icon: "Box",
    category: "toy",
    price: 20,
    consumable: true,
    interactionKind: "played",
    needsEffect: { mood: 20, bond: 12 },
  },
  // ── Decor (non-consumable cosmetic) ────────────────────────────────────────
  {
    id: "star-charm",
    i18nKey: "starCharm",
    icon: "Star",
    category: "decor",
    price: 40,
    consumable: false,
    cosmetic: { hat: "crown" },
  },
]

export function getPetItem(id: string): PetShopItem | undefined {
  return PET_ITEMS.find((item) => item.id === id)
}
