"use client"

// Configure sub-tab — embeds the same configSchema-driven form that the
// modal `PluginConfigForm` uses, only rendered inline so the user doesn't
// have to open a dialog to tweak settings. The inline `variant` of
// `PluginConfigFormContent` swaps Dialog primitives for plain `<header>` /
// `<div>` chrome so the form blends into the surrounding pane.
//
// `onClose` is wired to a no-op (there's no host to close); the form's
// internal "Save" still calls `setPluginConfig`, the manager picks the
// change up on next activation, and the live-query in the body reflects
// the new persisted state.

import { PluginConfigFormContent } from "../plugin-config-form"

export function PluginDetailConfigure({ pluginId }: { pluginId: string }) {
  return (
    <div className="space-y-3">
      <PluginConfigFormContent pluginId={pluginId} onClose={() => undefined} variant="inline" />
    </div>
  )
}
