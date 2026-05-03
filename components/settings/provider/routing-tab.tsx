"use client"

/**
 * Routing tab — placeholder.
 *
 * Cognia ships a routing-rules editor (load balancer strategy, sticky
 * sessions, weighted distribution, alias mappings, model-mapping
 * registry). cognia-next deferred the reliability infrastructure that
 * powers those rules per the provider port plan; this placeholder lets
 * the advanced-tab shell render without a runtime crash and tells the
 * user where to look for the feature.
 */

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

export function RoutingTab() {
  return (
    <div className="p-4">
      <Alert>
        <AlertTitle>Routing rules deferred</AlertTitle>
        <AlertDescription className="text-xs">
          Smart routing (alias resolution, fallback chains, load balancing, model mapping) ships
          with the provider reliability infrastructure, which is on the cognia-next roadmap but not
          in this release. For now, the default-provider selection in the sidebar is the single
          source of truth for chat routing.
        </AlertDescription>
      </Alert>
    </div>
  )
}

export default RoutingTab
