"use client"

// Devtools section content.
//
// `HotReloadDiagnostics` is mounted here because its data was already being
// collected and nothing rendered it: `CliBridgeEventsBridge` (mounted from
// `desktop-only-initializers`) feeds `hot-reload-history-store` on every
// install / uninstall / hot-reload the CLI bridge reports, and the panel that
// reads that store had no production importer at all. The events were being
// recorded into a store no screen ever showed.

import { HotReloadDiagnostics } from "./hot-reload-diagnostics"
import { PluginDevSessionWorkbench } from "./plugin-dev-session-workbench"

export function PluginDevtoolsPane() {
  return (
    <div className="h-full min-h-0 overflow-y-auto" data-testid="plugin-devtools-pane">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 p-4 lg:p-5">
        <PluginDevSessionWorkbench />
        <HotReloadDiagnostics />
      </div>
    </div>
  )
}
