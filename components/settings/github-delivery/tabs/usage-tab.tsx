"use client"

/**
 * Usage sub-tab. Shows GitHub API quota and a daily count of bot actions.
 *
 * Phase M4 ships a placeholder card; live polling of /rate_limit and a
 * 30-day chart of audit-row counts land in the next iteration.
 */

import { GaugeIcon } from "lucide-react"
import { Card } from "@/components/ui/card"

export function UsageTab() {
  return (
    <div className="space-y-3" data-testid="usage-tab">
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <GaugeIcon className="h-5 w-5 text-muted-foreground" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold">GitHub API quota</h3>
            <p className="text-xs text-muted-foreground">
              Real-time quota readouts require the plugin to be enabled and at least one repo
              configured. Once that's in place we'll display 5K/hr core and search-API headroom
              here.
            </p>
          </div>
        </div>
      </Card>
      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-2">Recent activity</h3>
        <p className="text-xs text-muted-foreground">
          A rolling 30-day count of bot-driven merges, comments, and releases will render here once
          we have audit data to chart.
        </p>
      </Card>
    </div>
  )
}
