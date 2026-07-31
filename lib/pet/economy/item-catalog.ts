// Static shop catalog — the economy sibling of `lib/pet/achievements/registry.ts`.
// Definitions live in code; only ownership (`petInventory`) is persisted.
// Plugin-contributed items union in via the overlay registry (static-first;
// plugin ids are namespaced `plugin:<pluginId>:<id>` so they can't shadow).

import type { PetShopItem } from "@/types/pet"
import {
  getProjectedPluginItem,
  listProjectedPluginItems,
} from "@/lib/plugin/registries/pet-item-registry"

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
    id: "cookie",
    i18nKey: "cookie",
    icon: "Cookie",
    category: "food",
    price: 8,
    consumable: true,
    interactionKind: "fed",
    needsEffect: { energy: 18, mood: 12 },
  },
  {
    id: "herbal-tea",
    i18nKey: "herbalTea",
    icon: "CupSoda",
    category: "food",
    price: 10,
    consumable: true,
    interactionKind: "fed",
    needsEffect: { energy: 10, mood: 16 },
  },
  {
    id: "energy-drink",
    i18nKey: "energyDrink",
    icon: "Zap",
    category: "food",
    price: 12,
    consumable: true,
    interactionKind: "fed",
    // Jolt with a comedown: big energy, slight mood dip.
    needsEffect: { energy: 40, mood: -5 },
  },
  {
    id: "sushi-set",
    i18nKey: "sushiSet",
    icon: "Fish",
    category: "food",
    price: 15,
    consumable: true,
    interactionKind: "fed",
    needsEffect: { energy: 30, mood: 12, bond: 2 },
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
    id: "squeaky-duck",
    i18nKey: "squeakyDuck",
    icon: "Bird",
    category: "toy",
    price: 10,
    consumable: true,
    interactionKind: "played",
    needsEffect: { mood: 28, energy: -6, bond: 4 },
  },
  {
    id: "frisbee",
    i18nKey: "frisbee",
    icon: "Disc",
    category: "toy",
    price: 12,
    consumable: true,
    interactionKind: "played",
    // The workout toy: best bond-per-play, costs the most energy.
    needsEffect: { mood: 25, energy: -8, bond: 8 },
  },
  {
    id: "plushie",
    i18nKey: "plushie",
    icon: "Heart",
    category: "toy",
    price: 15,
    consumable: true,
    interactionKind: "played",
    needsEffect: { mood: 15, bond: 15 },
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
  // ── Care (consumable → sleep/clean/treat) ──────────────────────────────────
  {
    id: "bubble-bath",
    i18nKey: "bubbleBath",
    icon: "Bath",
    category: "care",
    price: 14,
    consumable: true,
    interactionKind: "cleaned",
    needsEffect: { mood: 20, energy: 5 },
  },
  {
    id: "cozy-blanket",
    i18nKey: "cozyBlanket",
    icon: "BedDouble",
    category: "care",
    price: 18,
    consumable: true,
    interactionKind: "slept",
    needsEffect: { energy: 50, mood: 5 },
  },
  {
    id: "first-aid-kit",
    i18nKey: "firstAidKit",
    icon: "BriefcaseMedical",
    category: "care",
    price: 30,
    consumable: true,
    interactionKind: "treated",
    // The unwell-recovery accelerator: broad restore across all needs.
    needsEffect: { energy: 20, mood: 20, bond: 5 },
  },
  // ── Decor (non-consumable cosmetic; hats unlock in the customize tab) ──────
  {
    id: "beanie",
    i18nKey: "beanie",
    icon: "GraduationCap",
    category: "decor",
    price: 25,
    consumable: false,
    cosmetic: { hat: "beanie" },
  },
  {
    id: "propeller-cap",
    i18nKey: "propellerCap",
    icon: "Fan",
    category: "decor",
    price: 35,
    consumable: false,
    cosmetic: { hat: "propeller" },
  },
  {
    id: "star-charm",
    i18nKey: "starCharm",
    icon: "Star",
    category: "decor",
    price: 40,
    consumable: false,
    cosmetic: { hat: "crown" },
  },
  {
    id: "tophat-box",
    i18nKey: "tophatBox",
    icon: "Gem",
    category: "decor",
    price: 45,
    consumable: false,
    cosmetic: { hat: "tophat" },
  },
  {
    id: "wizard-hat",
    i18nKey: "wizardHat",
    icon: "Wand2",
    category: "decor",
    price: 50,
    consumable: false,
    cosmetic: { hat: "wizard" },
  },
  {
    id: "halo-ring",
    i18nKey: "haloRing",
    icon: "Sun",
    category: "decor",
    price: 60,
    consumable: false,
    cosmetic: { hat: "halo" },
  },
]

/**
 * The decor item that unlocks a purchasable hat, or undefined for free /
 * genetics-only hats (`none` is always free; `tinyduck` is legendary-genetics
 * only and deliberately has no shop item). The customize tab uses this to
 * gate premium hats behind ownership so decor purchases stay meaningful.
 */
export function petHatItem(hat: string): PetShopItem | undefined {
  return PET_ITEMS.find((item) => item.cosmetic?.hat === hat)
}

export function getPetItem(id: string): PetShopItem | undefined {
  return PET_ITEMS.find((item) => item.id === id) ?? getProjectedPluginItem(id)
}

/** Full catalog: static items first, then plugin contributions. */
export function listAllPetItems(): PetShopItem[] {
  return [...PET_ITEMS, ...listProjectedPluginItems()]
}
