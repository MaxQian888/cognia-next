"use client"

import { useCapability, useHostProfile } from "@/hooks/use-host-profile"
import type { CapabilityId } from "@/lib/platform/capabilities"
import {
  resolveSurfaceReach,
  type SurfaceReach,
  type SurfaceRequirement,
} from "@/lib/platform/surface-reach"

export interface UseSurfaceReachOptions {
  /** Capability the surface needs. */
  capability: CapabilityId
  requirement?: SurfaceRequirement
  /**
   * Override for "a host holds this capability".
   *
   * `useCapability` answers from the local baseline plus the STATIC
   * server-backed list, which is the right default and is deliberately
   * conservative: it only names capabilities every host of that shape is
   * known to run. A surface whose host advertises the capability at runtime
   * (a feature-manifest entry, a probe) passes that answer in here, so the
   * static list does not have to grow a guess for every host that might have
   * it.
   */
  hostProvides?: boolean
}

/**
 * "Can this surface run from here, and if not, why?", bound to the live host
 * profile.
 *
 * The React face of `lib/platform/surface-reach.ts`. Use it in place of
 * `isTauri()` on any surface that has something honest to say when it cannot
 * run, which is most of them.
 */
export function useSurfaceReach({
  capability,
  requirement,
  hostProvides,
}: UseSurfaceReachOptions): SurfaceReach {
  const profile = useHostProfile()
  // Called unconditionally: hooks cannot be skipped just because the caller
  // supplied an override.
  const capabilityFromBaseline = useCapability(capability)
  return resolveSurfaceReach({
    profile,
    capability,
    capabilityAvailable: hostProvides ?? capabilityFromBaseline,
    requirement,
  })
}
