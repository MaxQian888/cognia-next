"use client"

/**
 * Presets tab — placeholder.
 *
 * Cognia ships one-click "fastest", "cheapest", "most reliable", etc.
 * routing presets backed by the auto-router and alias resolver.
 * cognia-next deferred the routing infrastructure per the provider
 * port plan; this placeholder keeps the Advanced shell rendering
 * cleanly.
 */

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

export function PresetsTab() {
  return (
    <div className="p-4">
      <Alert>
        <AlertTitle>Routing presets deferred</AlertTitle>
        <AlertDescription className="text-xs">
          One-click routing presets ship with the routing engine, which is on the roadmap but not in
          this release.
        </AlertDescription>
      </Alert>
    </div>
  )
}

export default PresetsTab
