/**
 * Plugin SDK helper for data-only pet shop item contributions.
 *
 * The runtime clamps projected prices defensively, but the SDK should surface
 * author mistakes early so marketplace packages do not rely on repair-at-use.
 */

import type { PluginPetItemDef } from "@/types/plugin/plugin-pet"

export function definePetItem(def: PluginPetItemDef): PluginPetItemDef {
  assertEnglishLabel(def.labels, `definePetItem: item "${def.id}"`)
  if (!Number.isFinite(def.price) || def.price <= 0) {
    throw new Error(`definePetItem: item "${def.id}" price must be a positive number`)
  }
  return def
}

function assertEnglishLabel(labels: Record<string, string>, context: string): void {
  if (typeof labels.en === "string" && labels.en.trim().length > 0) return
  throw new Error(`${context} must declare a non-empty English label at labels.en`)
}
