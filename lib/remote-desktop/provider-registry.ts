/**
 * Remote desktop providers (ADR-0234 §3): what a binding's `providerId`
 * names. A provider supplies the viewer, a default port and which server
 * features it can rely on; the Host supplies the protocol handshake from a
 * closed adapter list, the credentials and the network path. A provider never
 * sees a password or opens a socket of its own.
 *
 * `ctx.remoteDesktop.registerProvider(...)` (`lib/plugin/api/remote-desktop-api.ts`)
 * is the only production writer, as the `provider.remote-desktop` runtime
 * point. The first-party VNC provider is `plugins/remote-desktop-vnc`.
 *
 * Integration modes:
 * - `embedded`: an in-app viewer over the Host bridge (Phase 2).
 * - `web-console`: the user's own console page, opened by the client; the
 *   provider names a console profile from the Host's closed list (Phase 5).
 * - `external-app`: a local app the client hands an ID to; the provider names
 *   a launcher from the Host's closed list and never builds a URI (Phase 5).
 * - `native` is typed so a plugin can declare it and is refused here by
 *   name: native viewers are the sandboxes and managed desktops themselves,
 *   never a plugin (dormant on all three axes, CLAUDE.md rule 7).
 *
 * Viewers. A React component runs in the app's own document, so only an
 * in-tree first-party plugin may supply one. Every other plugin supplies a
 * sandboxed webview page that receives the session's bytes over a
 * `MessagePort` and never the bridge URL, its ticket or the transport.
 */

import type {
  RemoteDesktopAccess,
  RemoteDesktopAdapter,
  RemoteDesktopConsoleProfile,
  RemoteDesktopLauncher,
} from "./types"
import type {
  RemoteDesktopIntegrationMode,
  RemoteDesktopProviderDefinition,
} from "@cognia/plugin-contract/lib/remote-desktop/provider-registry"
export type {
  RemoteDesktopEmbeddedProvider,
  RemoteDesktopExternalAppProvider,
  RemoteDesktopIntegrationMode,
  RemoteDesktopNativeProvider,
  RemoteDesktopProviderCapabilities,
  RemoteDesktopProviderDefinition,
  RemoteDesktopViewer,
  RemoteDesktopViewerProps,
  RemoteDesktopViewerStatus,
  RemoteDesktopWebConsoleProvider,
} from "@cognia/plugin-contract/lib/remote-desktop/provider-registry"

export type { RemoteDesktopConnection, RemoteDesktopRawChannel } from "./stream"

/** The modes this build can open. Pinned by a test. */
export const IMPLEMENTED_INTEGRATION_MODES: readonly RemoteDesktopIntegrationMode[] = [
  "embedded",
  "web-console",
  "external-app",
]

/** The binding access a provider's bindings use. */
export function accessOfProvider(
  definition: RemoteDesktopProviderDefinition
): RemoteDesktopAccess | null {
  switch (definition.integrationMode) {
    case "embedded":
      return "bridge"
    case "web-console":
      return "web-console"
    case "external-app":
      return "external-app"
    default:
      return null
  }
}

export interface RemoteDesktopProviderRegistration {
  /** `<pluginId>.<id>`: what a binding stores as `providerId`. */
  providerId: string
  pluginId: string
  /** Whether the owner is an in-tree first-party plugin. */
  firstParty: boolean
  definition: RemoteDesktopProviderDefinition
}

/** A refusal with a stable code the console maps to a message. */
export class RemoteDesktopProviderError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "RemoteDesktopProviderError"
  }
}

/** The Host's own rule for binding provider ids (`target::valid_provider_id`). */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ADAPTERS: readonly RemoteDesktopAdapter[] = ["vnc", "none"]
const CONSOLE_PROFILES: readonly RemoteDesktopConsoleProfile[] = [
  "guacamole",
  "meshcentral",
  "generic",
]
const LAUNCHERS: readonly RemoteDesktopLauncher[] = ["rustdesk"]

const registry = new Map<string, RemoteDesktopProviderRegistration>()
const listeners = new Set<() => void>()
let snapshot: readonly RemoteDesktopProviderRegistration[] = []

function publish(): void {
  snapshot = [...registry.values()].sort((a, b) => a.providerId.localeCompare(b.providerId))
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.warn("remote desktop provider listener threw:", error)
    }
  }
}

export function providerIdOf(pluginId: string, id: string): string {
  return `${pluginId}.${id}`.toLowerCase()
}

function validate(registration: RemoteDesktopProviderRegistration): void {
  const { definition } = registration
  if (!PROVIDER_ID.test(registration.providerId) || !/^[a-z0-9._-]+$/.test(definition.id)) {
    throw new RemoteDesktopProviderError("remote_desktop_provider_id_invalid")
  }
  if (!IMPLEMENTED_INTEGRATION_MODES.includes(definition.integrationMode)) {
    throw new RemoteDesktopProviderError("remote_desktop_integration_unavailable")
  }
  if (definition.integrationMode === "web-console") {
    if (!CONSOLE_PROFILES.includes(definition.consoleProfile)) {
      throw new RemoteDesktopProviderError("remote_desktop_console_profile_unknown")
    }
    return
  }
  if (definition.integrationMode === "external-app") {
    // A closed list: no plugin builds a URI that starts a local app.
    if (!LAUNCHERS.includes(definition.launcher)) {
      throw new RemoteDesktopProviderError("remote_desktop_launcher_unknown")
    }
    return
  }
  if (definition.integrationMode !== "embedded") {
    throw new RemoteDesktopProviderError("remote_desktop_integration_unavailable")
  }
  if (!ADAPTERS.includes(definition.adapter)) {
    throw new RemoteDesktopProviderError("remote_desktop_adapter_unknown")
  }
  if (
    !Number.isInteger(definition.defaultPort) ||
    definition.defaultPort < 1 ||
    definition.defaultPort > 65535
  ) {
    throw new RemoteDesktopProviderError("remote_desktop_provider_port_invalid")
  }
  if (definition.capabilities.viewOnlyPassword && definition.adapter !== "vnc") {
    // A server without authentication cannot tell a view session apart.
    throw new RemoteDesktopProviderError("remote_desktop_binding_cannot_be_read_only")
  }
  if (definition.viewer.kind === "react" && !registration.firstParty) {
    throw new RemoteDesktopProviderError("remote_desktop_viewer_requires_webview")
  }
  if (definition.viewer.kind === "webview" && !definition.viewer.viewId) {
    throw new RemoteDesktopProviderError("remote_desktop_viewer_invalid")
  }
}

/** Register a provider; returns its disposer. Duplicate ids are refused. */
export function registerRemoteDesktopProvider(
  registration: RemoteDesktopProviderRegistration
): () => void {
  validate(registration)
  if (registry.has(registration.providerId)) {
    throw new RemoteDesktopProviderError("remote_desktop_provider_duplicate")
  }
  registry.set(registration.providerId, registration)
  publish()
  return () => {
    if (registry.get(registration.providerId) === registration) {
      registry.delete(registration.providerId)
      publish()
    }
  }
}

/** Remove everything a plugin registered (unload, crash, disable). */
export function unregisterRemoteDesktopProvidersOf(pluginId: string): number {
  let removed = 0
  for (const [id, registration] of registry) {
    if (registration.pluginId === pluginId) {
      registry.delete(id)
      removed += 1
    }
  }
  if (removed > 0) publish()
  return removed
}

export function getRemoteDesktopProvider(
  providerId: string
): RemoteDesktopProviderRegistration | undefined {
  return registry.get(providerId)
}

/** Stable snapshot for `useSyncExternalStore`. */
export function listRemoteDesktopProviders(): readonly RemoteDesktopProviderRegistration[] {
  return snapshot
}

export function subscribeRemoteDesktopProviders(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test-only reset. */
export function __resetRemoteDesktopProvidersForTests(): void {
  registry.clear()
  publish()
}
