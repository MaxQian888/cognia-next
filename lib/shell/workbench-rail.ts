/**
 * Icon mapping + catalog assembly + layout resolver for the Context Workbench's
 * activity rail (`components/context-workbench/context-workbench.tsx`).
 *
 * The pure (icon-free) model lives in `@/types/shell/workbench-rail`; this
 * module is the only one that pulls in lucide, so the persistence layer stays
 * icon-free. Mirrors the split `lib/shell/sidebar-nav.ts` uses for the nav rail.
 *
 * One catalog for every host. The activities are a shared vocabulary
 * (`CANONICAL_CONTEXT_ACTIVITIES`), and each workbench simply renders the ones
 * its own panels declare — so a single stored order serves the chat dock,
 * Canvas, the workflow editor and the project editor without any of them
 * needing to know about the others.
 */

import {
  BotIcon,
  EyeIcon,
  FolderTreeIcon,
  InfoIcon,
  type LucideIcon,
  MessageSquareIcon,
  PlugIcon,
  Rows3Icon,
  SquareCheckIcon,
} from "lucide-react"

import { resolveOrderedLayout, type ResolvedOrderedCatalog } from "@/lib/shell/layout-partition"
import {
  CONTEXT_ACTIVITY_RAIL_ORDER,
  type CanonicalContextActivity,
  type ContextActivity,
} from "@/types/context-workbench"
import {
  DEFAULT_WORKBENCH_RAIL_LAYOUT,
  type WorkbenchRailLayout,
} from "@/types/shell/workbench-rail"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"

/**
 * Representative icon per canonical activity, for the customizer only.
 *
 * The rail itself keeps drawing the *active panel's* icon, because an activity
 * can hold several panels and the glyph should say which one is in front. The
 * customizer has no active panel to read, so it needs a stable stand-in.
 */
export const WORKBENCH_ACTIVITY_ICONS: Record<CanonicalContextActivity, LucideIcon> = {
  "preview-run": EyeIcon,
  review: SquareCheckIcon,
  ai: BotIcon,
  comments: MessageSquareIcon,
  inspect: InfoIcon,
  workspace: FolderTreeIcon,
  templates: Rows3Icon,
}

/** A catalog entry with its resolved icon. */
export interface WorkbenchRailCatalogItem {
  /**
   * The activity id. For a canonical activity this is also the i18n key leaf
   * under `contextWorkbench.activities`; a plugin-contributed one has no such
   * key, which is what the label fields below exist for.
   */
  id: ContextActivity
  Icon: LucideIcon
  /**
   * Literal label for a plugin-contributed activity, taken from the first
   * panel registered into it. Absent for canonical activities, which the
   * customizer translates from their id.
   *
   * Without this the customizer rendered `contextWorkbench.activities.<id>`
   * verbatim for every plugin activity — `getWorkbenchRailCatalogWithPlugins`
   * has always returned ids that key cannot resolve.
   */
  label?: string
  /** The contributing panel's own translation key, preferred over `label`. */
  labelKey?: string
  /** Set for plugin-contributed activities; namespaces `labelKey`. */
  pluginId?: string
}

/**
 * The customizable activity catalog.
 *
 * Canonical activities only. Plugin-contributed ones are appended to the live
 * rail by {@link resolveWorkbenchRailLayout} but are deliberately absent here:
 * a plugin can be uninstalled, and offering a permanent "hide" toggle for an
 * activity that may vanish would leave dead ids in the stored layout.
 */
export function getWorkbenchRailCatalog(): WorkbenchRailCatalogItem[] {
  // Built from the rail order, not `CANONICAL_CONTEXT_ACTIVITIES` (which is
  // alphabetical): catalog order is what `resolveOrderedLayout` falls back to
  // for ids a stored layout never mentioned, so it has to be the rail's order
  // to be meaningful. The two lists hold the same members — pinned by a test.
  // No runtime fallback: the map is typed `Record<CanonicalContextActivity, …>`,
  // so adding an activity without an icon is a compile error rather than a
  // silent glyph — a guarantee an `?? Rows3Icon` could only pretend to give.
  return CONTEXT_ACTIVITY_RAIL_ORDER.map((id) => ({
    id,
    Icon: WORKBENCH_ACTIVITY_ICONS[id as CanonicalContextActivity],
  }))
}

/**
 * Extended catalog that includes both canonical activities AND activities
 * contributed by currently-registered plugins.
 *
 * Plugin activities are discovered from `contextPanelRegistry` and appended
 * after the canonical ones with a generic PlugIcon. When a plugin is uninstalled,
 * its activities naturally drop out of the next call's result; the stored layout
 * keeps the id (harmlessly) but `resolveOrderedLayout` ignores ids absent from
 * the catalog, so dead entries never surface in the customizer.
 */
export function getWorkbenchRailCatalogWithPlugins(): WorkbenchRailCatalogItem[] {
  const canonical = getWorkbenchRailCatalog()
  const canonicalIds = new Set(canonical.map((item) => item.id))

  // Carry the contributing panel's label with the activity: the customizer has
  // no panel in front to read one from, and an activity id is not a label.
  const panels = contextPanelRegistry.listPanels()
  const pluginActivities = contextPanelRegistry
    .listActivities()
    .filter((activity) => !canonicalIds.has(activity))
    .map((activity) => {
      const panel = panels.find((entry) => entry.activity === activity)
      return {
        id: activity,
        Icon: PlugIcon,
        label: panel?.label,
        labelKey: panel?.labelKey,
        pluginId: panel?.pluginId,
      }
    })

  return [...canonical, ...pluginActivities]
}

/** Resolution of the canonical catalog against a stored layout. */
export type ResolvedWorkbenchRail = ResolvedOrderedCatalog<WorkbenchRailCatalogItem>

export function resolveWorkbenchRailLayout(
  catalog: WorkbenchRailCatalogItem[],
  layout: WorkbenchRailLayout
): ResolvedWorkbenchRail {
  return resolveOrderedLayout(catalog, layout)
}

/**
 * Rail position of `activity` under `layout`, for sorting the live rail.
 *
 * Unknown activities — every plugin-contributed one — sort after the named
 * entries, preserving the guarantee that a third-party panel can never fall off
 * the rail. This replaces `contextActivityRailIndex`'s fixed lookup once a user
 * layout exists; that function remains the source of the *default* order.
 */
export function workbenchRailIndex(activity: ContextActivity, layout: WorkbenchRailLayout): number {
  const index = layout.order.indexOf(activity)
  return index === -1 ? layout.order.length : index
}

/**
 * Whether `activity` should render a rail button.
 *
 * Hiding only removes the *button*: the panel stays in the workbench's resolved
 * set, so the command palette and `ctrl+1..7` still reach it. That fallback is
 * what makes hiding safe to offer at all — without it, hiding the sole entry
 * point to a panel would strand it.
 */
export function isWorkbenchActivityHidden(
  activity: ContextActivity,
  layout: WorkbenchRailLayout
): boolean {
  return layout.hidden.includes(activity)
}

/** True when `layout` matches the shipped default. */
export function isDefaultWorkbenchRailLayout(layout: WorkbenchRailLayout): boolean {
  return (
    layout.hidden.length === 0 &&
    layout.order.length === DEFAULT_WORKBENCH_RAIL_LAYOUT.order.length &&
    layout.order.every((id, index) => id === DEFAULT_WORKBENCH_RAIL_LAYOUT.order[index])
  )
}
