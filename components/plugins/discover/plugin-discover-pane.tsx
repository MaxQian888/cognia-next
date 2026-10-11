"use client"

// Discover section content — currently a thin wrapper around the existing
// PluginMarketplace surface. Kept as a dedicated file so the shell can
// uniformly delegate to "<XPane />" per active section, and so future
// refinements (featured carousel, install-receipt history) can land
// without touching the panel-level router.

import { PluginMarketplace } from "../marketplace/plugin-marketplace"

export function PluginDiscoverPane() {
  return (
    // Padding follows the PANE's width (anonymous `@container`), not the
    // viewport: on a wide window beside an open detail pane, `sm:p-4` gave a
    // narrow column the roomy padding and took width from the cards.
    <div
      className="@container h-full min-h-0 min-w-0 max-w-full overflow-x-clip overflow-y-auto"
      data-testid="plugin-discover-pane"
    >
      <div className="p-3 @lg:p-4">
        <PluginMarketplace />
      </div>
    </div>
  )
}
