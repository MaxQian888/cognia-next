"use client"

/**
 * Health tab — placeholder.
 *
 * Cognia ships a real-time health dashboard backed by the provider
 * manager's availability monitor, latency probes, and circuit-breaker
 * stores. cognia-next deferred the reliability infrastructure per the
 * provider port plan, so this placeholder explains the gap and points
 * to the manual "Test Connection" button on the Config tab.
 */

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

export function HealthTab() {
  return (
    <div className="p-4">
      <Alert>
        <AlertTitle>Health dashboard deferred</AlertTitle>
        <AlertDescription className="text-xs">
          Real-time provider health metrics (latency p95, error rate, rolling availability,
          circuit-breaker state) are part of the reliability infrastructure roadmap. Until then, use
          the &ldquo;Test Connection&rdquo; button on the Config tab for an ad-hoc check.
        </AlertDescription>
      </Alert>
    </div>
  )
}

export default HealthTab
