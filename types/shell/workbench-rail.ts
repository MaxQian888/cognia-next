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

/**
 * The rail's width in px — the `w-12` the workbench draws, named because it is
 * now also a *layout* number every host needs: it is what a collapsed panel
 * shrinks to when the rail is persistent, so `ResizablePanel.collapsedSize`,
 * the collapse animation's target and the workbench's own class all have to
 * agree. Lives in this pure module rather than beside the icon map so the chat
 * dock can read it without pulling lucide into its module graph.
 */
export const WORKBENCH_RAIL_WIDTH_PX = 48

/**
 * A user-defined group of panels that displays as a single activity rail item.
 * Clicking the group shows a tab strip in the panel body to switch between its
 * member panels. The group's id is used in `order`/`hidden` exactly like a
 * canonical activity id.
 *
 * **Intentionally dormant.** Nothing reads `WorkbenchRailLayout.groups` and
 * nothing writes it: the rail sorts by `workbenchRailIndex` over `order` alone,
 * and the customizer edits only `{ order, hidden }`. The shape is kept because
 * it is the extension point the panel-level customization in
 * `lib/shell/workbench-panels.ts` will grow into, and retiring it would strand
 * any layout already carrying one.
 *
 * Per Working Rule 7 the dormancy is also stated in the UI —
 * `components/shell/workbench-customizer.tsx` renders a disabled "planned" row —
 * and pinned by `workbench-customizer.test.tsx`. The one live obligation is that
 * mutators must *spread* the layout rather than rebuild it, or they delete this
 * field behind the user's back; `use-workbench-rail-layout.test.ts` holds that.
 */
export interface WorkbenchRailGroup {
  /** Unique group id, prefixed `group:` to avoid colliding with activity ids. */
  id: string
  /** User-chosen label shown in the customizer and as a tooltip on the rail. */
  label: string
  /** Lucide icon name string (resolved by the renderer). */
  icon: string
  /** Panel ids that belong to this group, in tab order. */
  panelIds: string[]
}

/** User customization of the workbench activity rail. */
export interface WorkbenchRailLayout {
  /**
   * Activity ids in render order. Hidden ids keep their slot here, so unhiding
   * one puts it back where the user left it rather than at the end.
   */
  order: string[]
  /** Activity ids removed from the rail. Still carry a position in `order`. */
  hidden: string[]
  /** User-defined panel groups that appear as single rail items. */
  groups?: WorkbenchRailGroup[]
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
  groups: [],
}
