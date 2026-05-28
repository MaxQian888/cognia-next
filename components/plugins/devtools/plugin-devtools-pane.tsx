"use client"

// Devtools section content — wraps the existing PluginDevtoolsPanel + the
// extension-points diagnostics surface so power-user diagnostics are one
// place. Visibility of the entire section is gated by `useDevtoolsGate()`
// in the nav sidebar; this component renders unconditionally because the
// shell only mounts it when the gate is open.

import { PluginDevtoolsPanel } from "../plugin-devtools-panel"
import { PluginPointDiagnosticsPanel } from "../plugin-point-diagnostics-panel"
import { LocalPluginDropzone } from "./local-plugin-dropzone"
import { ManifestValidator } from "./manifest-validator"
import { HotReloadDiagnostics } from "./hot-reload-diagnostics"
import { CogniaCliStatusCard } from "./cognia-cli-status-card"

export function PluginDevtoolsPane() {
  return (
    <div
      className="h-full min-h-0 overflow-y-auto p-4 space-y-4"
      data-testid="plugin-devtools-pane"
    >
      {/* CLI status + author-facing local-load surfaces first: check the
       *  cognia CLI, drop a folder, validate a manifest, watch hot-reload
       *  activity. Then the existing runtime diagnostics panels. */}
      <CogniaCliStatusCard />
      <LocalPluginDropzone />
      <ManifestValidator />
      <HotReloadDiagnostics />
      <PluginDevtoolsPanel />
      <PluginPointDiagnosticsPanel />
    </div>
  )
}
