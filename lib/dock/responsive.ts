/**
 * Fit a desktop dock layout onto a smaller screen.
 *
 * A dock arrangement is authored at desktop width and then has to survive being
 * looked at on a tablet or a phone. The naive approaches both fail: scaling the
 * grid down produces panes too narrow to use (a 24% dock on an 820px tablet is
 * ~197px), and dropping to a single panel throws away the arrangement so the
 * user loses it when they come back to a laptop.
 *
 * So the transform is a *projection*, not a mutation. The stored layout is
 * always the desktop one; this derives what to show at the current size, and
 * the projection is discarded when the window grows again. Nothing here writes.
 *
 * - **desktop** — the layout as authored.
 * - **tablet** — at most two regions side by side. Everything from the regions
 *   that did not survive becomes tabs of the ones that did, so no panel
 *   disappears.
 * - **mobile** — one full-height region. Every panel is a tab of it, and the
 *   layout manager is how you move between them.
 */

import type { DockPanelInstance } from "@/types/dock/instance"

export type DockViewportClass = "desktop" | "tablet" | "mobile"

/** One column of the projected layout. */
export interface DockResponsiveRegion {
  /** Instance ids, in tab order. Never empty. */
  instanceIds: string[]
  /** Which of them is active. */
  activeInstanceId: string
  /** Share of the dock's width, as a fraction. Sums to 1 across regions. */
  fraction: number
}

export interface DockResponsiveLayout {
  viewport: DockViewportClass
  regions: DockResponsiveRegion[]
  /**
   * True when the projection had to merge regions, so the UI can explain why
   * the arrangement looks different from the one the user built.
   */
  collapsed: boolean
}

/** Region counts each viewport class can render usably. */
export const DOCK_MAX_REGIONS: Record<DockViewportClass, number> = {
  desktop: Number.POSITIVE_INFINITY,
  tablet: 2,
  mobile: 1,
}

export interface DockResponsiveInput {
  viewport: DockViewportClass
  /**
   * The desktop arrangement, as groups of instance ids in visual order. The
   * host derives this from the live dockview api; the transform stays pure so
   * it can be reasoned about without a layout engine.
   */
  groups: ReadonlyArray<{ instanceIds: readonly string[]; activeInstanceId?: string }>
  /** The instance table, used to keep tab order stable and drop stale ids. */
  instances: readonly DockPanelInstance[]
  /** The instance the user is looking at, if any. */
  activeInstanceId?: string | null
}

/**
 * Project a desktop arrangement onto `viewport`.
 *
 * Merging folds later regions into the *last surviving* one rather than the
 * first: the rightmost region is where secondary tools live, so collapsing into
 * it keeps the primary surface — the leftmost region — undisturbed.
 */
export function projectDockLayout(input: DockResponsiveInput): DockResponsiveLayout {
  const known = new Set(input.instances.map((i) => i.instanceId))

  const groups = input.groups
    .map((group) => ({
      instanceIds: group.instanceIds.filter((id) => known.has(id)),
      activeInstanceId: group.activeInstanceId,
    }))
    .filter((group) => group.instanceIds.length > 0)

  if (groups.length === 0) {
    return { viewport: input.viewport, regions: [], collapsed: false }
  }

  const max = DOCK_MAX_REGIONS[input.viewport]
  const kept = groups.length <= max ? groups : mergeTail(groups, max)

  const fraction = 1 / kept.length
  const regions = kept.map((group) => ({
    instanceIds: group.instanceIds,
    activeInstanceId: resolveActive(group, input.activeInstanceId),
    fraction,
  }))

  return { viewport: input.viewport, regions, collapsed: kept.length < groups.length }
}

function mergeTail(
  groups: ReadonlyArray<{ instanceIds: string[]; activeInstanceId?: string }>,
  max: number
): Array<{ instanceIds: string[]; activeInstanceId?: string }> {
  const kept = groups
    .slice(0, max)
    .map((group) => ({ ...group, instanceIds: [...group.instanceIds] }))
  const overflow = groups.slice(max)
  const target = kept[kept.length - 1]!
  for (const group of overflow) {
    for (const id of group.instanceIds) {
      if (!target.instanceIds.includes(id)) target.instanceIds.push(id)
    }
  }
  return kept
}

/**
 * The active tab of a region: whatever the user is actually looking at if it
 * lives here, then the region's own remembered active tab, then its first.
 */
function resolveActive(
  group: { instanceIds: string[]; activeInstanceId?: string },
  userActive: string | null | undefined
): string {
  if (userActive && group.instanceIds.includes(userActive)) return userActive
  if (group.activeInstanceId && group.instanceIds.includes(group.activeInstanceId)) {
    return group.activeInstanceId
  }
  return group.instanceIds[0]!
}

/** Which viewport class a width belongs to. Mirrors `hooks/ui/use-breakpoint`. */
export function dockViewportClassOf(width: number): DockViewportClass {
  if (width < 768) return "mobile"
  if (width < 1024) return "tablet"
  return "desktop"
}
