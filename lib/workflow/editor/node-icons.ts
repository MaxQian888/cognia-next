/**
 * The single lucide icon lookup for a workflow node kind.
 *
 * There used to be two icon tables. The palette rendered
 * `nodeCatalogEntry(kind).iconName` (177 entries) and the canvas rendered a
 * separate hand-kept map (about 60), so the ~120 kinds present in one but not
 * the other showed one glyph in the sidebar and a generic `Workflow` the
 * moment they landed on the canvas. Every `action.agent.turn`,
 * `action.plan.*`, `action.goal.*`, `action.memory.*` and `action.scheduler.*`
 * node fell in that gap, and the 4 kinds the two tables *both* described
 * disagreed about which glyph to use.
 *
 * The catalog is the source now, for the palette, the canvas node and
 * Spotlight alike. Pure data, no React and no DOM: callers import
 * `getNodeIcon(kind)` and render the returned `LucideIcon` directly.
 */

import * as LucideIcons from "lucide-react"
import { Workflow as WorkflowIcon, type LucideIcon } from "lucide-react"

import { nodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import type { WorkflowNodeKind } from "@/types/workflow/visual"

export const FALLBACK_NODE_ICON: LucideIcon = WorkflowIcon

/**
 * Resolve a catalog `iconName` to its component. Names are authored by hand in
 * `catalog.ts` and by plugin authors in a manifest, so a typo has to degrade
 * rather than throw.
 */
function iconFromCatalogName(name: string | undefined): LucideIcon | null {
  if (!name) return null
  const icon = (LucideIcons as unknown as Record<string, unknown>)[name]
  return typeof icon === "function" || typeof icon === "object" ? (icon as LucideIcon) : null
}

export function getNodeIcon(kind: WorkflowNodeKind | undefined | null): LucideIcon {
  if (!kind) return FALLBACK_NODE_ICON
  return iconFromCatalogName(nodeCatalogEntry(kind).iconName) ?? FALLBACK_NODE_ICON
}
