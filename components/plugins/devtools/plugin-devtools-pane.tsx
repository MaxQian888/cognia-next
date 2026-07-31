"use client"

// Devtools section content — wraps the existing PluginDevtoolsPanel + the
// extension-points diagnostics surface so power-user diagnostics are one
// place. Visibility of the entire section is gated by `useDevtoolsGate()`
// in the nav sidebar; this component renders unconditionally because the
// shell only mounts it when the gate is open.

import { PluginDevtoolsPanel } from "../plugin-devtools-panel"
import { PluginPointDiagnosticsPanel } from "../plugin-point-diagnostics-panel"
import { CogniaCliStatusCard } from "./cognia-cli-status-card"
import { HotReloadDiagnostics } from "./hot-reload-diagnostics"
import { LocalPluginDropzone } from "./local-plugin-dropzone"
import { ManifestValidator } from "./manifest-validator"

export function PluginDevtoolsPane() {
  return (
    <div className="h-full min-h-0 overflow-y-auto" data-testid="plugin-devtools-pane">
      <div className="mx-auto w-full max-w-[1440px] space-y-4 p-4 lg:p-5">
        {/* Setup actions share a row on desktop. The only-child rule lets the
         * CLI card reclaim the full row when the Tauri-only dropzone returns
         * null in web mode. */}
        <div
          className="grid grid-cols-1 gap-4 lg:grid-cols-12 [&>:only-child]:lg:col-span-12"
          data-testid="plugin-devtools-setup-grid"
        >
          <CogniaCliStatusCard className="lg:col-span-7" />
          <LocalPluginDropzone className="lg:col-span-5" />
        </div>

        <div
          className="grid grid-cols-1 gap-4 lg:grid-cols-12"
          data-testid="plugin-devtools-monitoring-grid"
        >
          <ManifestValidator className="lg:col-span-5" />
          <HotReloadDiagnostics className="lg:col-span-7" />
        </div>

        <div className="space-y-4">
          <PluginDevtoolsPanel />
          <PluginPointDiagnosticsPanel />
        </div>
      </div>
    </div>
  )
}
