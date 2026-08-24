/**
 * Icon mapping + catalog assembly + layout resolver for the desktop left
 * navigation rail (`components/shell/guild-rail.tsx`).
 *
 * The pure (icon-free) catalog and `SidebarLayout` model live in
 * `@/types/shell/sidebar`; this module is the only one that pulls in lucide,
 * so the persistence layer stays icon-free.
 */

import {
  CircleDot as CircleDotIcon,
  FolderKanban as FolderKanbanIcon,
  LayoutDashboard as LayoutDashboardIcon,
  ActivityIcon,
  BotIcon,
  BrainIcon,
  CalendarClockIcon,
  ClipboardCheckIcon,
  CompassIcon,
  GaugeIcon,
  GitBranchIcon,
  GlobeIcon,
  InboxIcon,
  LayoutGridIcon,
  ListChecksIcon,
  LayoutTemplateIcon,
  PanelsTopLeftIcon,
  PawPrintIcon,
  PlugIcon,
  ScrollTextIcon,
  ServerCogIcon,
  SmartphoneIcon,
  SparklesIcon,
  TargetIcon,
  UserRoundIcon,
  Users2Icon,
  WorkflowIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { arrayMove } from "@dnd-kit/sortable"

import type { Platform } from "@/hooks/use-platform"
import { partitionByLayout } from "@/lib/shell/layout-partition"
import type { RuntimeSnapshot } from "@/lib/runtime/operation-availability"
import { getSurfaceContract, shouldShowSurface } from "@/lib/runtime/surface-contract"
import {
  LEGACY_SIDEBAR_NAV_IDS,
  SIDEBAR_NAV_META,
  type SidebarLayout,
  type SidebarNavMeta,
} from "@/types/shell/sidebar"

/** id → rail icon. Must cover every id in `SIDEBAR_NAV_META`. */
export const SIDEBAR_NAV_ICONS: Record<string, LucideIcon> = {
  workflows: WorkflowIcon,
  inbox: InboxIcon,
  twin: BotIcon,
  discover: CompassIcon,
  templates: LayoutTemplateIcon,
  issues: CircleDotIcon,
  "issue-projects": FolderKanbanIcon,
  workspace: LayoutDashboardIcon,
  skills: SparklesIcon,
  plugins: PlugIcon,
  squads: Users2Icon,
  scheduler: CalendarClockIcon,
  goals: TargetIcon,
  pet: PawPrintIcon,
  browser: GlobeIcon,
  "source-control": GitBranchIcon,
  "agent-runs": ListChecksIcon,
  sites: PanelsTopLeftIcon,
  a2ui: LayoutGridIcon,
  memory: BrainIcon,
  observability: GaugeIcon,
  servers: ServerCogIcon,
  devices: SmartphoneIcon,
  eval: ClipboardCheckIcon,
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
 * Off the desktop shell (mobile AND plain/cloud-companion browsers — ADR-0059
 * F5), `desktopOnly` items are dropped so they never surface in the rail or
 * the customizer as dead ends. Falls back to a question-mark-free no-op icon
 * only if a mapping is missing (shouldn't happen — covered by tests).
 */
export function getSidebarCatalog(
  platform: Platform,
  runtimeSnapshot?: RuntimeSnapshot
): SidebarCatalogItem[] {
  return SIDEBAR_NAV_META.filter((meta) => {
    if (platform === "tauri") return true
    // `desktopOnly` is a shell constraint, not a runtime capability. A paired
    // desktop may advertise the underlying operation to a phone, but the
    // mobile drawer must still not expose destinations designed only for the
    // desktop shell. Check this before the runtime contract so the initial
    // target-less snapshot cannot temporarily reveal them either.
    if (platform === "mobile" && meta.desktopOnly) return false
    if (runtimeSnapshot) {
      const contract = getSurfaceContract(meta.id)
      // No `platform !== "tauri"` guard: the `tauri` case returned above, so it
      // was always true by the time control reached here.
      if (runtimeSnapshot.target === null && contract?.standalone === "hidden") {
        return false
      }
      return contract ? shouldShowSurface(contract, runtimeSnapshot) : false
    }
    const contract = getSurfaceContract(meta.id)
    if (contract?.standalone === "hidden") return false
    return !meta.desktopOnly
  }).map((m) => ({
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
  return partitionByLayout(catalog, migrateLegacyIds(layout))
}

/**
 * Rewrite ids that were renamed after layouts were already saved.
 *
 * Without this a rename reads as "the item vanished from my rail" — the
 * partition drops unknown ids by design, so a stale `agent-teams` pin would
 * silently become an unpinned Squads entry sitting in More.
 */
function migrateLegacyIds(layout: SidebarLayout): SidebarLayout {
  const map = (ids: readonly string[]) => ids.map((id) => LEGACY_SIDEBAR_NAV_IDS[id] ?? id)
  const pinned = map(layout.pinned)
  const hidden = map(layout.hidden)
  const changed =
    pinned.some((id, i) => id !== layout.pinned[i]) ||
    hidden.some((id, i) => id !== layout.hidden[i])
  return changed ? { ...layout, pinned, hidden } : layout
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
