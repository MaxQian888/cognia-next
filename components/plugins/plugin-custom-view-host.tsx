"use client"

// Renders a plugin `type: "react"` custom view (B2) — an arbitrary panel
// component the plugin contributed. Wrapped in the shared
// PluginExtensionBoundary so a throwing view can't take down the host.

import type React from "react"
import type { PluginViewProps } from "@/types/plugin/plugin-view"
import { PluginExtensionBoundary } from "@/components/plugins/plugin-extension-slot"

interface Props {
  component: React.ComponentType<PluginViewProps>
  pluginId: string
  viewId: string
}

export function PluginCustomViewHost({ component: View, pluginId, viewId }: Props) {
  return (
    <PluginExtensionBoundary pluginId={pluginId} extensionId={viewId}>
      <View pluginId={pluginId} viewId={viewId} />
    </PluginExtensionBoundary>
  )
}
