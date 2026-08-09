"use client"

/**
 * RoutingRuntimeInitializer — installs the provider-routing runtime adapters
 * once at app startup so the routing engine reads LIVE telemetry/settings
 * (health, circuit breaker, today-spend, rate windows, in-flight counts,
 * session affinity, difficulty router + semantic tool router) instead of the
 * inert package defaults.
 *
 * `setProviderRoutingRuntimeAdapters` must run exactly once; the `useRef`
 * guard makes this idempotent under React 18 Strict Mode's double-invoke.
 * Returns null — provider-shaped, not a render component. Mirrors
 * `AgentTeamRuntimeInitializer`.
 */

import { useEffect, useRef } from "react"

import { setProviderRoutingRuntimeAdapters } from "@cognia/provider-routing/runtime-adapters"
import { buildRoutingRuntimeAdapters } from "@/lib/claude/routing-runtime-deps"

export function RoutingRuntimeInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    setProviderRoutingRuntimeAdapters(buildRoutingRuntimeAdapters())
    void import("@/lib/ai/agent/execution/certification-store")
      .then(async ({ installDesktopCertificationRuntime }) => {
        const store = await installDesktopCertificationRuntime()
        if (!store) return
        const { rebuildCompatibilityProjection } = await import("@/lib/db/agent-compatibility")
        await rebuildCompatibilityProjection(store)
      })
      .catch(() => undefined)
  }, [])

  return null
}

export default RoutingRuntimeInitializer
