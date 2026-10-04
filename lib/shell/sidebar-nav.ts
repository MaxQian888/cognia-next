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
  BotMessageSquareIcon,
  BrainIcon,
  CalendarClockIcon,
  CircleDot as CircleDotIcon,
  ClipboardCheckIcon,
  CompassIcon,
  GitBranchIcon,
  GlobeIcon,
  InboxIcon,
  LayoutDashboard as LayoutDashboardIcon,
  LayoutGridIcon,
  LayoutTemplateIcon,
  ListChecksIcon,
  PanelsTopLeftIcon,
  PawPrintIcon,
  PlugIcon,
  PlugZapIcon,
  ScrollTextIcon,
  ServerCogIcon,
  SmartphoneIcon,
  SparklesIcon,
  TargetIcon,
  UserRoundIcon,
  Users2Icon,
  WorkflowIcon,
  FolderOpenIcon,
  HistoryIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { arrayMove } from "@dnd-kit/sortable"

import type { Platform } from "@/hooks/use-platform"
import {
  partitionByLayout,
  resolveOrderedLayout,
  type ResolvedOrderedCatalog,
} from "@/lib/shell/layout-partition"
import type { RuntimeSnapshot } from "@/lib/runtime/operation-availability"
import { getSurfaceContract, shouldShowSurface } from "@/lib/runtime/surface-contract"
import {
  CANVAS_MODE_ID,
  LEGACY_SIDEBAR_NAV_IDS,
  SIDEBAR_NAV_META,
  type SidebarLayout,
  type SidebarModesLayout,
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
  files: FolderOpenIcon,
  // Not `MessagesSquareIcon`: that one is the Go menu's Chats entry.
  conversations: HistoryIcon,
  a2ui: LayoutGridIcon,
  memory: BrainIcon,
  servers: ServerCogIcon,
  integrations: PlugZapIcon,
  devices: SmartphoneIcon,
  // Not `BotIcon`: that one is Twin's, and two rail entries sharing a glyph
  // is indistinguishable once the rail is collapsed to icons.
  bots: BotMessageSquareIcon,
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
 * the customizer as dead ends. On the web a paired host can bring one back,
 * but only a surface with a host `operation` it can advertise; one without
 * (the pet) is a shell constraint and stays dropped. Falls back to a
 * question-mark-free no-op icon only if a mapping is missing (shouldn't
 * happen — covered by tests).
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
    // Built for full clients only (see `SidebarNavMeta.mobileHidden`).
    if (platform === "mobile" && meta.mobileHidden) return false
    // A desktop-only surface with no host operation cannot be served by any
    // companion, so no runtime snapshot can make it reachable here. Without
    // this the web path below consulted only the surface contract, and the pet
    // (`standalone: "explain"`) showed in a browser's rail and ⌘K as a page
    // that could only explain it does not run there.
    if (meta.desktopOnly && !getSurfaceContract(meta.id)?.operation) return false
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
 *
 * Exported because the write path needs it too: the layout mutators in
 * `components/shell/use-sidebar-layout.ts` operate on the stored arrays, and a
 * `hide("squads")` against a stored `"agent-teams"` pin used to filter for an
 * id that was not there — the stale pin survived, still resolved as pinned,
 * and the action did nothing. A rename can also collide with a pin the user
 * already added under the new name, so the mapped arrays are de-duplicated
 * (first occurrence wins, which keeps the user's order).
 */
export function migrateLegacyIds(layout: SidebarLayout): SidebarLayout {
  const map = (ids: readonly string[]) => [
    ...new Set(ids.map((id) => LEGACY_SIDEBAR_NAV_IDS[id] ?? id)),
  ]
  const pinned = map(layout.pinned)
  const hidden = map(layout.hidden)
  const changed =
    pinned.length !== layout.pinned.length ||
    hidden.length !== layout.hidden.length ||
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

/** What {@link resolveSidebarModes} needs from a workspace-mode entry. */
export interface SidebarModeEntry {
  /** {@link CANVAS_MODE_ID}, or a plugin view container's `fullId`. */
  id: string
  /**
   * The contributor's declared sort order (`PluginViewContainerDef.order`).
   * Ascending; absent reads as `0`, the default that type documents.
   */
  order?: number
}

/**
 * The mode block's shipped order: Canvas first — it is built in and was the
 * block's only entry before plugins could add one — then the plugin
 * containers by their declared `order`, ties keeping registration order
 * (`Array.prototype.sort` is stable).
 */
export function defaultModeOrder<T extends SidebarModeEntry>(entries: readonly T[]): T[] {
  const rank = (entry: T) =>
    entry.id === CANVAS_MODE_ID ? Number.NEGATIVE_INFINITY : (entry.order ?? 0)
  return [...entries].sort((a, b) => rank(a) - rank(b))
}

/**
 * Resolve the workspace modes on the rail — Canvas and the plugin view
 * containers — against the user's `SidebarLayout.modes`.
 *
 * The declared order is only the default: a stored `modes.order` wins, and a
 * mode it never mentioned (a plugin installed after the last reorder) joins
 * the end in its default position. Hidden modes keep their slot, so showing
 * one again puts it back where it was. An absent `modes` — every layout saved
 * before this block was customizable — is the default order, nothing hidden.
 */
export function resolveSidebarModes<T extends SidebarModeEntry>(
  entries: readonly T[],
  modes: SidebarModesLayout | undefined
): ResolvedOrderedCatalog<T> {
  return resolveOrderedLayout(defaultModeOrder(entries), modes ?? { order: [], hidden: [] })
}

/**
 * The catalog entry whose page `pathname` is on, or `null` off every catalog
 * route (`/`, `/settings`, a route the rail does not list). Same prefix rule
 * the rail's active state uses (`useShellNav().isFeatureActive`): `/inbox/123`
 * is Inbox. The longest matching route wins, so a future nested entry would
 * not be shadowed by its parent.
 */
export function navItemForPath<T extends { route: string }>(
  pathname: string,
  catalog: readonly T[]
): T | null {
  let best: T | null = null
  for (const item of catalog) {
    const matches = pathname === item.route || pathname.startsWith(item.route + "/")
    if (matches && (!best || item.route.length > best.route.length)) best = item
  }
  return best
}

/**
 * The full mode order to store after the *visible* modes were rearranged into
 * `visibleOrder`. Hidden modes keep the slots they hold in `order`, and the
 * visible ones fill the remaining slots in their new sequence — so hiding a
 * mode, dragging its neighbours around and showing it again puts it back
 * where it was, not at the end.
 */
export function mergeVisibleModeOrder(
  order: readonly string[],
  hidden: ReadonlySet<string>,
  visibleOrder: readonly string[]
): string[] {
  const queue = [...visibleOrder]
  return order.map((id) => (hidden.has(id) ? id : (queue.shift() ?? id)))
}

/**
 * The stored mode order after moving visible mode `id` by `delta` slots among
 * the visible modes, or `null` when it has nowhere to go.
 */
export function moveVisibleMode(
  order: readonly string[],
  hidden: ReadonlySet<string>,
  id: string,
  delta: number
): string[] | null {
  const visible = order.filter((modeId) => !hidden.has(modeId))
  const from = visible.indexOf(id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= visible.length) return null
  return mergeVisibleModeOrder(order, hidden, arrayMove(visible, from, to))
}
