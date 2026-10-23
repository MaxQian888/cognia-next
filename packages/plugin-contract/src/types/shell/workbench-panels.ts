/**
 * Pure (icon-free) layout model for the Context Workbench's *panels* — the tabs
 * inside an activity, one level below the activity rail that
 * `@/types/shell/workbench-rail` models.
 *
 * Kept free of React / lucide imports so `AppSettings` and the persistence layer
 * can read `WorkbenchPanelLayout` without pulling the icon set into their module
 * graph, exactly like `@/types/shell/sidebar` and `@/types/shell/bars`. The
 * catalog and the resolver live in `lib/shell/workbench-panels.ts`.
 *
 * `{ order, hidden }` — the same shape as the rail and the window bars, so it
 * resolves through the same `resolveOrderedLayout`. There is no "More" bucket to
 * overflow into: a panel is either a tab in its group or it is not.
 *
 * **Ordering is within an activity, not across all panels.** The rail decides
 * which activity is in front; this decides the tab order underneath it. One flat
 * id list is enough to express that — the resolver reads it per group — and a
 * per-activity map would have to be migrated every time a panel changed
 * activity.
 */

/** User customization of the workbench's panel tabs. */
export interface WorkbenchPanelLayout {
  /**
   * Panel ids in tab order. Hidden ids keep their slot here, so unhiding one
   * puts it back where the user left it rather than at the end.
   */
  order: string[]
  /**
   * Panel ids removed from their group's tab strip. Still carry a position in
   * `order`.
   *
   * Hiding takes away the *tab*, never the panel: it stays in the workbench's
   * resolved set, so the command palette, `Ctrl+Shift+E` and the activity
   * shortcuts still reach it. That fallback is the whole reason hiding is safe
   * to offer — see `isWorkbenchPanelHidden`.
   */
  hidden: string[]
}

/**
 * The shipped layout: no stored order, nothing hidden.
 *
 * Deliberately an *empty* order rather than a copy of the catalog. Panels
 * already carry an `order:` number in their definitions, and
 * `resolveOrderedLayout` appends anything the stored order never mentioned in
 * catalog order — so an empty list means "use the shipped order", and a panel
 * added later surfaces with no migration. Baking today's ids in would freeze the
 * shipped order into every user's settings the first time they opened the
 * customizer.
 */
export const DEFAULT_WORKBENCH_PANEL_LAYOUT: WorkbenchPanelLayout = {
  order: [],
  hidden: [],
}
