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
 *
 * It also installs the host's pricing resolver into `@cognia/provider-core`.
 * That package cannot import `lib/`, so it ships a `defaultModelPricingResolver`
 * that omits the static `MODEL_PRICING` / `MODEL_PRICING_CNY` layer. The
 * `setModelPricingResolver` seam existed for the host to close that gap but had
 * no caller, so the routing engine's cost-aware ranking and `dailyCostBudget`
 * saw `null` (unknown price) for every model that only the static tables know,
 * while the Usage tab and the CLI priced the same model fine — the exact
 * two-pricing-systems divergence `lib/usage/pricing.ts` was written to end.
 */

import { useEffect, useRef } from "react"

import { setProviderRoutingRuntimeAdapters } from "@cognia/provider-routing/runtime-adapters"
import { setModelPricingResolver } from "@cognia/provider-core/providers/model-pricing"
import { buildRoutingRuntimeAdapters } from "@/lib/claude/routing-runtime-deps"
import { resolveModelPricingUsd } from "@/lib/usage/pricing"

export function RoutingRuntimeInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    setProviderRoutingRuntimeAdapters(buildRoutingRuntimeAdapters())
    // One pricing authority for routing, the gateway snapshot, the Usage tab
    // and the CLI. `resolveModelPricingUsd` is a superset of the package
    // default — same layer order, plus the static tables.
    setModelPricingResolver((providerId, modelId, opts) =>
      resolveModelPricingUsd(providerId, modelId, opts)
    )
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
