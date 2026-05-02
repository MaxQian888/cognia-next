import type { Plugin } from "@/types/plugin"

interface ReloadablePluginManager {
  disablePlugin: (pluginId: string, reason?: string) => Promise<void>
  enablePlugin: (pluginId: string, reason?: string) => Promise<void>
}

export async function reloadExtensionRuntime(
  manager: ReloadablePluginManager,
  plugin: Plugin
): Promise<void> {
  if (plugin.status === "enabled") {
    await manager.disablePlugin(plugin.manifest.id, "dev-reload")
  }
  await manager.enablePlugin(plugin.manifest.id, "dev-reload")
}
