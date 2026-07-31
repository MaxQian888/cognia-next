"use client"

import { useSyncExternalStore } from "react"
import {
  isContextWorkbenchSurfaceEnabled,
  type ContextWorkbenchSurface,
} from "@/lib/context-workbench/feature-flags"

const subscribe = () => () => undefined

export function useContextWorkbenchSurfaceFlag(surface: ContextWorkbenchSurface): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isContextWorkbenchSurfaceEnabled(surface),
    () => true
  )
}
