/**
 * Plugin SDK helper for remote desktop providers (ADR-0234). Pure typesafety
 * pass-through for the object passed to `ctx.remoteDesktop.registerProvider`
 * (`remote-desktop:provide`).
 *
 * A provider names the Host adapter (`vnc` or `none`), a default port, the
 * server features it relies on, and its viewer. Built-in plugins may render a
 * React viewer; any other plugin supplies a sandboxed webview view that
 * receives the session's bytes over a `MessagePort`. The Host keeps the
 * handshake, the passwords and the connection.
 *
 * Usage:
 *   ctx.remoteDesktop.registerProvider(defineRemoteDesktopProvider({
 *     id: "vnc",
 *     name: "VNC",
 *     integrationMode: "embedded",
 *     adapter: "vnc",
 *     defaultPort: 5900,
 *     capabilities: { viewOnlyPassword: true },
 *     viewer: { kind: "webview", viewId: "viewer" },
 *   }))
 */

import type { RemoteDesktopProviderDefinition } from "@/lib/plugin/api/remote-desktop-api"

export function defineRemoteDesktopProvider(
  def: RemoteDesktopProviderDefinition
): RemoteDesktopProviderDefinition {
  return def
}
