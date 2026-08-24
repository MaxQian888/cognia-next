/**
 * Types the Activity tab needs that are not worth importing a whole module for.
 *
 * `HostDispatchStatus` is re-exported rather than restated so the tone map in
 * `activity-tab.tsx` is exhaustive by construction — adding a status to the
 * queue's machine breaks the map at compile time instead of rendering an
 * uncoloured row.
 */

import type { PlacementDimension } from "@/lib/placement/types"

export type { HostDispatchStatus } from "@/types/placement/host-dispatch"

/** How many requirements this device satisfies, per dimension. */
export type PlacementDimensionCounts = Partial<Record<PlacementDimension, number>>
