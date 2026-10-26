/**
 * The plugin contract's share of `lib/plugin/api/remote-desktop-api.ts`, which re-exports these.
 */
import type { RemoteDesktopProviderDefinition } from "../../remote-desktop/provider-registry"

export interface PluginRemoteDesktopAPI {
  /**
   * Register a provider (`remote-desktop:provide`). Returns a disposer.
   * Throws a `RemoteDesktopProviderError` naming why a definition is refused
   * (for example `remote_desktop_integration_unavailable` for a mode this
   * version does not implement).
   */
  registerProvider(definition: RemoteDesktopProviderDefinition): () => void
}
