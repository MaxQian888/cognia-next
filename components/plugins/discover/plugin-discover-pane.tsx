"use client"

// Discover section content — currently a thin wrapper around the existing
// PluginMarketplace surface. Kept as a dedicated file so the shell can
// uniformly delegate to "<XPane />" per active section, and so future
// refinements (featured carousel, install-receipt history) can land
// without touching the panel-level router.

import { PluginMarketplace } from "../plugin-marketplace"

export function PluginDiscoverPane() {
  return (
    <div className="h-full min-h-0 overflow-y-auto p-4" data-testid="plugin-discover-pane">
      <PluginMarketplace />
    </div>
  )
}
