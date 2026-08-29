"use client"

import { PluginDevSessionWorkbench } from "./plugin-dev-session-workbench"

export function PluginDevtoolsPane() {
  return (
    <div className="h-full min-h-0 overflow-y-auto" data-testid="plugin-devtools-pane">
      <div className="mx-auto w-full max-w-[1440px] p-4 lg:p-5">
        <PluginDevSessionWorkbench />
      </div>
    </div>
  )
}
