"use client"

// Devtools section content — wraps the existing PluginDevtoolsPanel + the
// extension-points diagnostics surface so power-user diagnostics are one
// place. Visibility of the entire section is gated by `useDevtoolsGate()`
// in the nav sidebar; this component renders unconditionally because the
// shell only mounts it when the gate is open.

import { PluginDevtoolsPanel } from "../plugin-devtools-panel"
import { PluginPointDiagnosticsPanel } from "../plugin-point-diagnostics-panel"

export function PluginDevtoolsPane() {
  return (
    <div
      className="h-full min-h-0 overflow-y-auto p-4 space-y-4"
      data-testid="plugin-devtools-pane"
    >
      <PluginDevtoolsPanel />
      <PluginPointDiagnosticsPanel />
    </div>
  )
}
