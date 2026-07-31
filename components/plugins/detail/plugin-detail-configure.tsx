"use client"

// Configure sub-tab — embeds the configSchema-driven form inline so the user
// doesn't have to open a dialog to tweak settings. `PluginConfigFormContent`
// renders with plain `<header>` / `<div>` chrome so the form blends into the
// surrounding pane.
//
// `onClose` is wired to a no-op (there's no host to close); the form's
// internal "Save" still calls `setPluginConfig`, the manager picks the
// change up on next activation, and the live-query in the body reflects
// the new persisted state.

import { usePluginRow } from "@/hooks/plugins"
import { PluginConfigFormContent } from "./plugin-config-form"
import { PluginPythonHostSettings } from "./plugin-python-host-settings"

export function PluginDetailConfigure({ pluginId }: { pluginId: string }) {
  const rowState = usePluginRow(pluginId)
  const row = rowState.state === "ready" ? rowState.row : null
  const hasPythonHost = row?.type === "python" || row?.type === "hybrid"
  const pythonDependencies = Array.isArray(row?.manifest?.pythonDependencies)
    ? (row.manifest.pythonDependencies as string[])
    : []

  return (
    <div className="space-y-3">
      {hasPythonHost && (
        <PluginPythonHostSettings pluginId={pluginId} pythonDependencies={pythonDependencies} />
      )}
      <PluginConfigFormContent pluginId={pluginId} onClose={() => undefined} />
    </div>
  )
}
