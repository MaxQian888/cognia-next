/**
 * `ctx.remoteDesktop`: the `provider.remote-desktop` runtime point (ADR-0234
 * §3). A plugin registers a provider (viewer, default port, server features)
 * under the `remote-desktop:provide` permission; the Host keeps the protocol
 * handshake, the credentials and the network path, so a provider never holds
 * a password or a socket.
 *
 * Ownership comes from `pluginId`: the registered id is `<pluginId>.<id>`, and
 * `unregisterPluginContributions` removes everything a plugin registered when
 * it is disabled or unloaded. Only a built-in (in-tree) plugin may supply a
 * React viewer; any other plugin supplies a sandboxed webview view.
 */

import {
  providerIdOf,
  registerRemoteDesktopProvider,
  type RemoteDesktopProviderDefinition,
} from "@/lib/remote-desktop/provider-registry"

export type { RemoteDesktopProviderDefinition }

export interface PluginRemoteDesktopAPI {
  /**
   * Register a provider (`remote-desktop:provide`). Returns a disposer.
   * Throws a `RemoteDesktopProviderError` naming why a definition is refused
   * (for example `remote_desktop_integration_unavailable` for a mode this
   * version does not implement).
   */
  registerProvider(definition: RemoteDesktopProviderDefinition): () => void
}

export interface CreateRemoteDesktopAPIOptions {
  hasPermission: (permission: string) => boolean
  /** The plugin ships in-tree (`source === "builtin"`). */
  firstParty: boolean
}

export const REMOTE_DESKTOP_PROVIDE_PERMISSION = "remote-desktop:provide"

export function createRemoteDesktopAPI(
  pluginId: string,
  options: CreateRemoteDesktopAPIOptions
): PluginRemoteDesktopAPI {
  return {
    registerProvider(definition) {
      if (!options.hasPermission(REMOTE_DESKTOP_PROVIDE_PERMISSION)) {
        throw new Error(
          `ctx.remoteDesktop.registerProvider requires the "${REMOTE_DESKTOP_PROVIDE_PERMISSION}" permission — declare it in the plugin manifest.`
        )
      }
      return registerRemoteDesktopProvider({
        providerId: providerIdOf(pluginId, definition.id),
        pluginId,
        firstParty: options.firstParty,
        definition,
      })
    },
  }
}
