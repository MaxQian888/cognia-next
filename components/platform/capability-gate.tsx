"use client"

import type { ReactNode } from "react"

import { SurfaceUnavailableNotice } from "@/components/platform/surface-unavailable-notice"
import { useCapability, useHostProfile } from "@/hooks/use-host-profile"
import type { CapabilityId, HostProfile } from "@/lib/platform/capabilities"
import { resolveSurfaceReach } from "@/lib/platform/surface-reach"

export interface CapabilityGateProps {
  /**
   * Render children only when this capability is available, locally or
   * server-backed on a companion profile (`useCapability` semantics).
   */
  capability?: CapabilityId
  /**
   * Render children only on these host profiles. Combined with `capability`,
   * BOTH must pass. Use for surfaces bound to the local shell (e.g. the
   * desktop pet window) where a server-backed capability does not help.
   */
  profiles?: readonly HostProfile[]
  /**
   * Explain the refusal instead of vanishing.
   *
   * Hiding a control collapses three different answers into one silence: it
   * never existed here, it is one pairing away, or it is broken right now. A
   * user cannot tell those apart from an empty space, and the third one is the
   * only one they can act on. When `explain` is set and no `fallback` is
   * given, the gate renders `SurfaceUnavailableNotice`, which names the cause
   * and the next step when there is one.
   *
   * Off by default: a handful of call sites gate decoration rather than
   * function, and a paragraph explaining why an ornament is missing is worse
   * than the ornament being missing.
   */
  explain?: boolean
  /** Rendered when the gate fails. Takes precedence over `explain`. */
  fallback?: ReactNode
  children: ReactNode
}

/**
 * Declarative capability degradation for UI surfaces (ADR-0059 F5).
 *
 * Replaces ad-hoc `isTauri() && ...` branches with the capability vocabulary,
 * so a cloud companion (browser paired to a headless cognia-server) degrades
 * by declared capability rather than by shell checks scattered per component.
 */
export function CapabilityGate({
  capability,
  profiles,
  explain,
  fallback,
  children,
}: CapabilityGateProps) {
  const profile = useHostProfile()
  // Hooks must run unconditionally, so evaluate against a universally-present
  // capability when the prop is absent. The gate then reduces to the profile
  // check.
  const capabilityOk = useCapability(capability ?? "webview")
  const profileOk = !profiles || profiles.includes(profile)
  if ((capability ? capabilityOk : true) && profileOk) return <>{children}</>
  if (fallback !== undefined) return <>{fallback}</>
  if (!explain) return null
  // A failed PROFILE check with a satisfied capability is the "needs the
  // desktop process itself" case: the work could run somewhere, but this
  // surface is bound to a particular shell. Saying "the host lacks it" there
  // would be wrong in a way the user could act on and get nowhere.
  const requirement = profileOk ? "capability" : "desktop-shell"
  return (
    <SurfaceUnavailableNotice
      reach={resolveSurfaceReach({
        profile,
        capability,
        capabilityAvailable: capabilityOk,
        requirement,
      })}
    />
  )
}
