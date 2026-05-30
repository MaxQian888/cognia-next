/**
 * Icon mapping + catalog assembly + layout resolver for the desktop left
 * navigation rail (`components/shell/guild-rail.tsx`).
 *
 * The pure (icon-free) catalog and `SidebarLayout` model live in
 * `@/types/shell/sidebar`; this module is the only one that pulls in lucide,
 * so the persistence layer stays icon-free.
 */

import {
  ActivityIcon,
  BotIcon,
  CalendarClockIcon,
  CompassIcon,
  GaugeIcon,
  GitBranchIcon,
  InboxIcon,
  PlugIcon,
  ScrollTextIcon,
  SparklesIcon,
  TargetIcon,
  UserRoundIcon,
  Users2Icon,
  WorkflowIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { arrayMove } from "@dnd-kit/sortable"

import type { Platform } from "@/hooks/use-platform"
import { SIDEBAR_NAV_META, type SidebarLayout, type SidebarNavMeta } from "@/types/shell/sidebar"

/** id → rail icon. Must cover every id in `SIDEBAR_NAV_META`. */
export const SIDEBAR_NAV_ICONS: Record<string, LucideIcon> = {
  workflows: WorkflowIcon,
  inbox: InboxIcon,
  twin: BotIcon,
  discover: CompassIcon,
  skills: SparklesIcon,
  plugins: PlugIcon,
  "agent-teams": Users2Icon,
  scheduler: CalendarClockIcon,
  goals: TargetIcon,
  "source-control": GitBranchIcon,
  observability: GaugeIcon,
  performance: ActivityIcon,
  logs: ScrollTextIcon,
  me: UserRoundIcon,
}

/** A catalog entry with its resolved icon. */
export interface SidebarCatalogItem extends SidebarNavMeta {
  Icon: LucideIcon
}

/**
 * The customizable nav catalog with icons attached, filtered for the platform.
 * On mobile, `desktopOnly` items are dropped so they never surface in the rail
 * or the customizer. Falls back to a question-mark-free no-op icon only if a
 * mapping is missing (shouldn't happen — covered by tests).
 */
export function getSidebarCatalog(platform: Platform): SidebarCatalogItem[] {
  return SIDEBAR_NAV_META.filter((m) => !(platform === "mobile" && m.desktopOnly)).map((m) => ({
    ...m,
    Icon: SIDEBAR_NAV_ICONS[m.id] ?? ActivityIcon,
  }))
}

/** Resolved partition of the catalog into the three rail buckets. */
export interface ResolvedSidebar {
  pinned: SidebarCatalogItem[]
  overflow: SidebarCatalogItem[]
  hidden: SidebarCatalogItem[]
}

/**
 * Partition `catalog` according to `layout`:
 *
 *  - **pinned**: `layout.pinned` ids that exist in the catalog, in the user's
 *    stored order. Pinned wins over hidden if an id appears in both.
 *  - **hidden**: `layout.hidden` ids that exist and are not pinned, in catalog
 *    order.
 *  - **overflow**: everything else (catalog − pinned − hidden), in catalog
 *    order — so newly-added catalog items appear in "More" automatically.
 *
 * Unknown ids in the layout are dropped; duplicate pinned ids are deduped.
 */
export function resolveSidebarLayout(
  catalog: SidebarCatalogItem[],
  layout: SidebarLayout
): ResolvedSidebar {
  const byId = new Map(catalog.map((item) => [item.id, item]))

  const seen = new Set<string>()
  const pinned: SidebarCatalogItem[] = []
  for (const id of layout.pinned) {
    if (seen.has(id)) continue
    const item = byId.get(id)
    if (!item) continue
    seen.add(id)
    pinned.push(item)
  }

  const hiddenIds = new Set(layout.hidden.filter((id) => byId.has(id) && !seen.has(id)))

  const hidden: SidebarCatalogItem[] = []
  const overflow: SidebarCatalogItem[] = []
  for (const item of catalog) {
    if (seen.has(item.id)) continue
    if (hiddenIds.has(item.id)) hidden.push(item)
    else overflow.push(item)
  }

  return { pinned, overflow, hidden }
}

/**
 * Compute the new pinned order after a drag, or `null` if the drag is a no-op
 * (dropped on nothing, dropped on itself, or either id missing). Pure so the
 * reorder branch logic is testable without simulating a dnd-kit drag.
 */
export function applyDragReorder(
  ids: string[],
  activeId: string,
  overId: string | null
): string[] | null {
  if (overId == null || activeId === overId) return null
  const oldIndex = ids.indexOf(activeId)
  const newIndex = ids.indexOf(overId)
  if (oldIndex < 0 || newIndex < 0) return null
  return arrayMove(ids, oldIndex, newIndex)
}
