"use client"

import { ObservabilityDashboard } from "@/components/observability/observability-dashboard"

/**
 * Dedicated full-page Agent observability route, reached from the guild-rail
 * "Observability" entry. The dashboard owns its own chrome (header + toolbar +
 * grid); this page just hosts it full-height. Unlike `/performance`, the data
 * lives in Dexie, so this works in the browser and on mobile too.
 */
export default function ObservabilityPage() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <ObservabilityDashboard />
    </div>
  )
}
