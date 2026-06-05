"use client"

// Routing tab inside the per-provider settings dialog. The configuration it
// hosts (strategy / alias mappings / constraints / presets) is GLOBAL — the
// panel says so in a banner. The legacy "Coming Soon" placeholder is gone:
// the engine behind it (ProviderRoutingEngine, ADR-0043) is fully wired.

import { RoutingConfigPanel } from "./routing/routing-config-panel"

interface RoutingTabProps {
  providerId?: string
  providerName?: string
}

export function RoutingTab(_props: RoutingTabProps) {
  return <RoutingConfigPanel />
}

export default RoutingTab
