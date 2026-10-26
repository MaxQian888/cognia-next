/**
 * The host's side of the contract's dispatch seam
 * (`@cognia/plugin-contract/lib/plugin/core/plugin-host-dispatch`).
 *
 * Every target stays a lazy import, as it was when the registries lived in
 * the host: the slash registry and the shortcut bridge pull in large parts of
 * the app, and the plugin store imports this module while it is created.
 */

import {
  installPluginHostDispatch,
  type PluginHostDispatch,
} from "@cognia/plugin-contract/lib/plugin/core/plugin-host-dispatch"

export const hostPluginDispatch: PluginHostDispatch = {
  async dispatchSlashCommand(line, ctx) {
    const { dispatchSlashCommand } = await import("@/lib/slash-commands/registry")
    return dispatchSlashCommand(line, ctx)
  },
  async findManifestCommand(pluginId, commandId) {
    const { usePluginStore } = await import("@/stores/plugin-runtime")
    return usePluginStore
      .getState()
      .plugins[pluginId]?.commands?.find((command) => command.id === commandId)
  },
  async bindPluginShortcut(request) {
    const { bindPluginShortcut } = await import("@/lib/plugin/shortcuts/plugin-shortcut-bridge")
    return bindPluginShortcut(request)
  },
}

/** Install the host dispatcher into the contract registries. Idempotent. */
export function installHostPluginDispatch(): void {
  installPluginHostDispatch(hostPluginDispatch)
}
