import type { ComponentType } from "react"
import { icons } from "lucide-react"
import type { PluginContextPanelIcon } from "@/types/plugin/plugin-context-panel"

/** Resolve a declared icon name, or `undefined` for panels that omit one. */
export function resolveContextPanelIcon(
  icon: PluginContextPanelIcon | undefined
): ComponentType<{ className?: string }> | undefined {
  return icon ? (icons[icon] as ComponentType<{ className?: string }> | undefined) : undefined
}
