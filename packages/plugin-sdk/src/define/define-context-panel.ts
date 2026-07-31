import type { PluginContextPanelDef } from "@/types/plugin/plugin-context-panel"

/** Preserve literal panel metadata while validating the public manifest shape. */
export function defineContextPanel<const T extends PluginContextPanelDef>(panel: T): T {
  return panel
}
