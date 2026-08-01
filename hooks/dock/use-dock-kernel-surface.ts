"use client"

import { useState } from "react"
import {
  isDockKernelSurfaceEnabled,
  type DockKernelSurface,
} from "@/lib/context-workbench/feature-flags"

/**
 * Whether this host renders on the Dock kernel, read once per mount.
 *
 * Pinned for the lifetime of the mount on purpose. The flag selects the layout
 * *engine*, and the two keep their state in different stores — flipping it
 * mid-life would swap a live dockview grid for a workbench (or the reverse)
 * with no path for the panels in flight, which is a worse failure than needing
 * a reload to see the change. Rollback is a page reload away in every tier:
 * localStorage, `NEXT_PUBLIC_DOCK_KERNEL=0`, or the code default.
 */
export function useDockKernelSurface(surface: DockKernelSurface): boolean {
  const [enabled] = useState(() => isDockKernelSurfaceEnabled(surface))
  return enabled
}
