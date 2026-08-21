/**
 * Catalog + layout resolver for the Context Workbench's *panels* — the tabs
 * inside an activity, one level below the activity rail that
 * `lib/shell/workbench-rail.ts` serves.
 *
 * The pure model lives in `@/types/shell/workbench-panels`; this module is the
 * one that knows the shipped panel set and can reach the plugin registry.
 * Mirrors the rail's split exactly.
 *
 * **Why a static catalog.** Panel definitions are built inside React hooks
 * (`useArtifactSurfacePanels` / `useSessionSurfacePanels`) that close over
 * session, project and selection state, so there is nothing to enumerate at
 * rest — the customizer has no live workbench to ask when it is opened from
 * Settings. The ids, activities and label keys are literals in that file, so a
 * catalog is a duplicate of something real rather than an invention, and
 * `workbench-panels.parity.test.ts` scrapes the source to hold the two in step.
 * `lib/context-workbench/taxonomy-parity.test.ts` already answers the identical
 * problem for the activity taxonomy the same way.
 */

import { resolveOrderedLayout, type ResolvedOrderedCatalog } from "@/lib/shell/layout-partition"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import type { ContextActivity } from "@/types/context-workbench"
import {
  DEFAULT_WORKBENCH_PANEL_LAYOUT,
  type WorkbenchPanelLayout,
} from "@/types/shell/workbench-panels"

/** A customizable panel: its id, the activity it groups under, and its label. */
export interface WorkbenchPanelCatalogItem {
  id: string
  activity: ContextActivity
  /** Full i18n key — panels label themselves from all over the message tree. */
  labelKey: string
  /** Literal fallback label, for plugin panels that ship no translation. */
  label?: string
  /** Set for plugin-contributed panels; namespaces the translation lookup. */
  pluginId?: string
}

/**
 * The first-party panels the chat dock can show, across both of its surfaces.
 *
 * A union, not two lists: `activePanelId` is per-resource but the *customization*
 * is one preference, and a user who hides "Memory" means it on both surfaces.
 * Ids that appear on both (`comments`, `browser`, `artifacts`, …) appear once.
 *
 * Canvas, the workflow editor and the project editor contribute their own panels
 * inline and are deliberately absent: their panel sets are small, surface-
 * specific, and not reachable from the chat dock's customizer. Adding them later
 * is an append here plus a line in the parity test.
 */
export const WORKBENCH_PANEL_CATALOG: readonly WorkbenchPanelCatalogItem[] = [
  { id: "preview", activity: "preview-run", labelKey: "artifacts.dock.artifactMode" },
  { id: "browser", activity: "preview-run", labelKey: "browser.title" },
  { id: "artifacts", activity: "review", labelKey: "artifacts.dock.browseArtifacts" },
  { id: "proposal-review", activity: "review", labelKey: "contextWorkbench.proposalReview" },
  { id: "resource-chat", activity: "ai", labelKey: "contextWorkbench.resourceChat" },
  { id: "session-sidechat", activity: "ai", labelKey: "contextWorkbench.sessionSidechat" },
  { id: "squad-context", activity: "ai", labelKey: "contextWorkbench.squadPanel.title" },
  { id: "team-members", activity: "ai", labelKey: "contextWorkbench.teamMembersPanel.title" },
  { id: "project-overview", activity: "workspace", labelKey: "projectOverview.panelTitle" },
  { id: "workspace", activity: "workspace", labelKey: "artifacts.dock.workspaceMode" },
  {
    id: "source-control",
    activity: "workspace",
    labelKey: "contextWorkbench.sourceControlPanel.title",
  },
  { id: "comments", activity: "comments", labelKey: "contextWorkbench.comments" },
  { id: "metadata", activity: "inspect", labelKey: "contextWorkbench.metadata.artifactTitle" },
  { id: "memory", activity: "inspect", labelKey: "contextWorkbench.memoryPanel.title" },
  { id: "run-context", activity: "inspect", labelKey: "contextWorkbench.runContext.title" },
  { id: "session-sources", activity: "inspect", labelKey: "contextWorkbench.sessionSources.title" },
  { id: "logs", activity: "inspect", labelKey: "contextWorkbench.logsPanel.title" },
] as const

/**
 * The catalog plus panels contributed by currently-registered plugins.
 *
 * Unlike the rail's equivalent, plugin panels *are* offered: a rail activity is
 * a permanent slot whose id would outlive an uninstall, but a hidden panel id
 * that no longer resolves is inert — `resolveOrderedLayout` drops ids absent
 * from the catalog, so an uninstalled plugin's entry simply stops appearing.
 */
export function getWorkbenchPanelCatalog(): WorkbenchPanelCatalogItem[] {
  const known = new Set(WORKBENCH_PANEL_CATALOG.map((item) => item.id))
  const plugin = contextPanelRegistry
    .listPanels()
    .filter((panel) => !known.has(panel.id))
    .map((panel) => ({
      id: panel.id,
      activity: panel.activity,
      labelKey: panel.labelKey,
      label: panel.label,
      pluginId: panel.pluginId,
    }))
  return [...WORKBENCH_PANEL_CATALOG, ...plugin]
}

export type ResolvedWorkbenchPanels = ResolvedOrderedCatalog<WorkbenchPanelCatalogItem>

export function resolveWorkbenchPanelLayout(
  catalog: WorkbenchPanelCatalogItem[],
  layout: WorkbenchPanelLayout
): ResolvedWorkbenchPanels {
  return resolveOrderedLayout(catalog, layout)
}

/**
 * Read a stored layout without subscribing to React — for the workbench's own
 * sort, which needs it inside a `useMemo` keyed on the settings field.
 */
export function workbenchPanelLayoutOf(
  stored: Partial<WorkbenchPanelLayout> | undefined
): WorkbenchPanelLayout {
  if (!stored) return DEFAULT_WORKBENCH_PANEL_LAYOUT
  return {
    order: stored.order ?? DEFAULT_WORKBENCH_PANEL_LAYOUT.order,
    hidden: stored.hidden ?? DEFAULT_WORKBENCH_PANEL_LAYOUT.hidden,
  }
}

/**
 * Tab position of `panelId` under `layout`, for sorting a group's tabs.
 *
 * Unmentioned ids — every panel the user has never reordered, and every
 * plugin-contributed one — sort after the named entries, preserving the
 * guarantee that a third-party panel can never fall out of its group. Ties are
 * then broken by the panel's own `order:` number, which is what keeps the
 * shipped order intact for an untouched layout.
 */
export function workbenchPanelIndex(panelId: string, layout: WorkbenchPanelLayout): number {
  const index = layout.order.indexOf(panelId)
  return index === -1 ? layout.order.length : index
}

/**
 * Whether `panelId` should render a tab.
 *
 * Hiding removes only the *tab*: the panel stays in the workbench's resolved
 * set, so `publishActiveContextPanels` still lists it and the command palette,
 * `Ctrl+Shift+E` and `Ctrl+1..7` still reach it. That fallback is what makes
 * hiding safe to offer at all — without it, hiding the sole entry point to a
 * panel would strand it. Identical rule to `isWorkbenchActivityHidden`.
 */
export function isWorkbenchPanelHidden(panelId: string, layout: WorkbenchPanelLayout): boolean {
  return layout.hidden.includes(panelId)
}

/** True when `layout` matches the shipped default. */
export function isDefaultWorkbenchPanelLayout(layout: WorkbenchPanelLayout): boolean {
  return layout.order.length === 0 && layout.hidden.length === 0
}
