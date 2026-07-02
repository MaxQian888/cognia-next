/**
 * Pet Item Registry — dynamic overlay for plugin-contributed shop items.
 * Plugins with the `pet-item` capability declare a `petItems` manifest array;
 * the `OVERLAY_REGISTRY_CAPABILITIES` dispatch loop registers each def on
 * enable and drops them via `unregisterPetItemsByPlugin(pluginId)` on disable.
 *
 * The host catalog (`lib/pet/economy/item-catalog.ts`) unions these entries
 * static-first: a plugin item can never shadow a built-in id because the
 * projected ids are namespaced `plugin:<pluginId>:<localId>`.
 */

import type { PluginPetItemDef } from "@/types/plugin/plugin-pet"
import type { PetShopItem } from "@/types/pet"
import { createOverlayRegistry } from "./createOverlayRegistry"

const registry = createOverlayRegistry<PluginPetItemDef>({
  name: "pet-item",
  keyFn: (id, _entry, opts) => `${opts?.pluginId ?? ""}:${id}`,
  conflictPolicy: "first-wins-cross-plugin",
})

export const registerPetItem = registry.register
export const unregisterPetItemById = registry.unregisterById
export const unregisterPetItemsByPlugin = registry.unregisterByPlugin
export const listPetItemEntries = registry.entries
export const __resetPetItemsForTesting = registry.__resetForTesting

/** Build the namespaced runtime id for a plugin item. */
export function buildPluginItemId(pluginId: string | undefined, localId: string): string {
  return `plugin:${pluginId ?? ""}:${localId}`
}

/** Project a data-only def into the host catalog shape. */
export function projectPluginItem(
  def: PluginPetItemDef,
  pluginId: string | undefined
): PetShopItem {
  return {
    id: buildPluginItemId(pluginId, def.id),
    // Plugin items carry display labels, not host i18n keys; the shop resolves
    // them via `getPluginItemDisplay`.
    i18nKey: def.id,
    icon: def.icon ?? "Sparkles",
    category: def.category,
    price: Math.max(1, Math.floor(def.price)),
    consumable: def.consumable,
    ...(def.interactionKind ? { interactionKind: def.interactionKind } : {}),
    ...(def.needsEffect ? { needsEffect: def.needsEffect } : {}),
  }
}

/** Every registered plugin item, projected for the shop/catalog union. */
export function listProjectedPluginItems(): PetShopItem[] {
  return registry.entries().map(({ entry, pluginId }) => projectPluginItem(entry, pluginId))
}

/** Resolve a namespaced plugin-item id back to its projected catalog shape. */
export function getProjectedPluginItem(runtimeId: string): PetShopItem | undefined {
  if (!runtimeId.startsWith("plugin:")) return undefined
  const rest = runtimeId.slice("plugin:".length)
  const firstColon = rest.indexOf(":")
  if (firstColon < 0) return undefined
  const key = `${rest.slice(0, firstColon)}:${rest.slice(firstColon + 1)}`
  const entry = registry.getEntry(key)
  return entry ? projectPluginItem(entry.entry, entry.pluginId) : undefined
}

/** Display metadata (labels/descriptions) for a namespaced plugin-item id. */
export function getPluginItemDisplay(
  runtimeId: string
): { def: PluginPetItemDef; pluginId?: string } | undefined {
  if (!runtimeId.startsWith("plugin:")) return undefined
  const rest = runtimeId.slice("plugin:".length)
  const firstColon = rest.indexOf(":")
  if (firstColon < 0) return undefined
  const key = `${rest.slice(0, firstColon)}:${rest.slice(firstColon + 1)}`
  const entry = registry.getEntry(key)
  return entry ? { def: entry.entry, pluginId: entry.pluginId } : undefined
}
