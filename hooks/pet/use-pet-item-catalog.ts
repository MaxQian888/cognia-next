// The full pet shop catalog (static items + plugin contributions) as a React
// read. Memoized by the plugin-item registry's revision, so a re-render from an
// inventory or profile live query does not re-project every plugin item, and a
// plugin that enables while the shop is open shows its items without a reload.

"use client"

import { useSyncExternalStore } from "react"
import { getPetCatalogSnapshot, subscribePetCatalog } from "@/lib/pet/economy/item-catalog"
import type { PetShopItem } from "@/types/pet"

export function usePetItemCatalog(): readonly PetShopItem[] {
  return useSyncExternalStore(subscribePetCatalog, getPetCatalogSnapshot, getPetCatalogSnapshot)
}
