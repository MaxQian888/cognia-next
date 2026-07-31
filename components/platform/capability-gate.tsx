"use client"

import type { ReactNode } from "react"

import { useCapability, useHostProfile } from "@/hooks/use-host-profile"
import type { CapabilityId, HostProfile } from "@/lib/platform/capabilities"

export interface CapabilityGateProps {
  /**
   * Render children only when this capability is available — locally or
   * server-backed on a companion profile (`useCapability` semantics).
   */
  capability?: CapabilityId
  /**
   * Render children only on these host profiles. Combined with `capability`,
   * BOTH must pass. Use for surfaces bound to the local shell (e.g. the
   * desktop pet window) where a server-backed capability doesn't help.
   */
  profiles?: readonly HostProfile[]
  /** Rendered when the gate fails; defaults to nothing. */
  fallback?: ReactNode
  children: ReactNode
}

/**
 * Declarative capability degradation for UI surfaces (ADR-0059 F5).
 *
 * Replaces ad-hoc `isTauri() && …` branches on feature surfaces with the
 * capability vocabulary, so cloud-companion (browser paired to a headless
 * cognia-server) degrades by declared capability instead of by shell checks
 * scattered per component.
 */
export function CapabilityGate({ capability, profiles, fallback, children }: CapabilityGateProps) {
  const profile = useHostProfile()
  // Hooks must run unconditionally — evaluate against a universally-present
  // capability when the prop is absent so the gate reduces to the profile check.
  const capabilityOk = useCapability(capability ?? "webview")
  const profileOk = !profiles || profiles.includes(profile)
  if ((capability ? capabilityOk : true) && profileOk) return <>{children}</>
  return <>{fallback ?? null}</>
}
