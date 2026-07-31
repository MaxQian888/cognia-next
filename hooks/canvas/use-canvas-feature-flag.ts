"use client"

/**
 * Read a canvas feature flag (`lib/canvas/feature-flags.ts`) on the client.
 *
 * Uses `useSyncExternalStore` so the value is read the idiomatic way (no
 * setState-in-effect): the server snapshot returns the default (`true`, matching
 * the SSR render) and the client snapshot reads the resolved env / localStorage
 * value, letting React reconcile without a hydration mismatch. This makes the
 * previously-dormant flag gate actually take effect.
 */

import { useSyncExternalStore } from "react"
import { isCanvasFeatureFlagEnabled, type CanvasFeatureFlag } from "@/lib/canvas/feature-flags"

// The flags come from env + localStorage; neither pushes change events, so the
// subscription is a no-op (the value is read once per render).
const noopSubscribe = () => () => {}

export function useCanvasFeatureFlag(flag: CanvasFeatureFlag): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => isCanvasFeatureFlagEnabled(flag),
    () => true
  )
}

export default useCanvasFeatureFlag
