import type { ComponentType } from "react"
import { resolveLucideIcon } from "@/lib/icons/lucide-catalog"
import type { PluginContextPanelIcon } from "@/types/plugin/plugin-context-panel"

/**
 * Resolve a declared icon name, or `undefined` for panels that omit one.
 *
 * Through the shared resolver, so a panel icon the manifest validator admitted
 * — including the kebab-case spelling the retired allowlist published — draws
 * instead of coming back empty.
 */
export function resolveContextPanelIcon(
  icon: PluginContextPanelIcon | undefined
): ComponentType<{ className?: string }> | undefined {
  return resolveLucideIcon(icon) ?? undefined
}
