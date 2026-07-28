"use client"

// Renders a plugin `type: "react"` custom view (B2). The common
// `PluginViewHost` owns scope anchoring and crash isolation.

import type React from "react"
import type { PluginViewProps } from "@/types/plugin/plugin-view"

interface Props {
  component: React.ComponentType<PluginViewProps>
  pluginId: string
  viewId: string
}

export function PluginCustomViewHost({ component: View, pluginId, viewId }: Props) {
  return <View pluginId={pluginId} viewId={viewId} />
}
