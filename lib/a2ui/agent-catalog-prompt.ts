/**
 * Prompt section telling an agent about its own A2UI catalog.
 *
 * `Character.a2uiCatalogId` decides which catalog renders the agent's
 * surfaces (`resolveA2UICatalogId`). The model can only use components it
 * knows exist, so when the agent's catalog is a registered custom one, list the
 * component types it provides. The standard catalog needs no section: the base
 * A2UI prompt already describes it.
 */

import { DEFAULT_CATALOG_ID, getRegisteredCatalogIds, getRegisteredTypes } from "./catalog"

export function buildAgentA2UICatalogSection(catalogId: string | undefined): string | undefined {
  if (!catalogId || catalogId === DEFAULT_CATALOG_ID) return undefined
  if (!getRegisteredCatalogIds().includes(catalogId)) return undefined
  const types = [...new Set(getRegisteredTypes(catalogId))].sort()
  if (types.length === 0) return undefined
  return [
    `## A2UI catalog`,
    `Your surfaces render with the "${catalogId}" component catalog. Besides the standard components it provides: ${types.join(", ")}.`,
    `Leave \`catalogId\` out of createSurface so your surfaces use it.`,
  ].join("\n")
}
