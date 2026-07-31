"use client"

// Routing tab inside the per-provider settings dialog. The configuration it
// hosts (strategy / alias mappings / constraints / presets) is GLOBAL — the
// panel says so in a banner (`globalScopeNote`). The legacy "Coming Soon"
// placeholder is gone: the engine behind it (ProviderRoutingEngine,
// ADR-0043) is fully wired. Takes no provider-scoped props by design — this
// tab is intentionally the same regardless of which provider is selected.

import { RoutingConfigPanel } from "./routing/routing-config-panel"

export function RoutingTab() {
  return <RoutingConfigPanel />
}

export default RoutingTab
