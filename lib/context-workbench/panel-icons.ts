import type { ComponentType } from "react"
import { getLucideIcon } from "@/lib/icons/lucide-catalog"
import type { PluginContextPanelIcon } from "@/types/plugin/plugin-context-panel"

/** Resolve a declared icon name, or `undefined` for panels that omit one. */
export function resolveContextPanelIcon(
  icon: PluginContextPanelIcon | undefined
): ComponentType<{ className?: string }> | undefined {
  return icon ? (getLucideIcon(icon) ?? undefined) : undefined
}
