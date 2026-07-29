/**
 * Pure (icon-free) layout model for the Context Workbench's activity rail —
 * the 48px icon column inside the right-hand workbench.
 *
 * Kept free of React / lucide imports so `AppSettings` and the persistence
 * layer can read `WorkbenchRailLayout` without pulling the icon set into their
 * module graph, exactly like `@/types/shell/sidebar` and `@/types/shell/bars`.
 * The icon mapping and the resolver live in `lib/shell/workbench-rail.ts`.
 *
 * `{ order, hidden }` rather than the rail's `{ pinned, hidden }`: an activity
 * is either on the rail or off it — there is no "More" popover to overflow
 * into. That is the same shape the window bars use, so it resolves through the
 * same `resolveOrderedLayout`.
 */

import { CONTEXT_ACTIVITY_RAIL_ORDER } from "@/types/context-workbench"

/** User customization of the workbench activity rail. */
export interface WorkbenchRailLayout {
  /**
   * Activity ids in render order. Hidden ids keep their slot here, so unhiding
   * one puts it back where the user left it rather than at the end.
   */
  order: string[]
  /** Activity ids removed from the rail. Still carry a position in `order`. */
  hidden: string[]
}

/**
 * The shipped layout: the canonical rail order, nothing hidden.
 *
 * `CONTEXT_ACTIVITY_RAIL_ORDER` stays the source of that order — this is a
 * *default*, not a fork of it. Plugin-contributed activities are deliberately
 * absent: they are appended in first-seen order by the resolver, matching how a
 * newly-added nav item lands in the rail's "More" without a layout edit.
 */
export const DEFAULT_WORKBENCH_RAIL_LAYOUT: WorkbenchRailLayout = {
  order: [...CONTEXT_ACTIVITY_RAIL_ORDER],
  hidden: [],
}
