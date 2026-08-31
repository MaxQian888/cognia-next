"use client"

// Devtools section content.
//
// `HotReloadDiagnostics` reads `hot-reload-history-store`, which is written by
// exactly two production paths: `use-cli-bridge-events` (install / uninstall
// the CLI bridge reports) and the `plugin_dev_reload` arm of
// `renderer-request-source` (the attempt, then its verified outcome). Until
// those writers existed the panel was mounted here and could never show
// anything, so any change that drops one of them puts it back to blank.

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
