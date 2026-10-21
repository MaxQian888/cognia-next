/**
 * Plugin SDK helper for remote desktop providers (ADR-0234). Pure typesafety
 * pass-through for the object passed to `ctx.remoteDesktop.registerProvider`
 * (`remote-desktop:provide`). It keeps the narrowed kind of the definition.
 *
 * Three kinds of provider:
 * - `embedded` names the Host adapter (`vnc` or `none`), a default port, the
 *   server features it relies on, and its viewer. Built-in plugins may render
 *   a React viewer; any other plugin supplies a sandboxed webview view that
 *   receives the session's bytes over a `MessagePort`. The Host keeps the
 *   handshake, the passwords and the connection.
 * - `web-console` names a console profile (`guacamole`, `meshcentral` or
 *   `generic`) the Host checks pasted links with; the client opens the page
 *   in an isolated webview or a browser, never with a credential.
 * - `external-app` names a launcher from the Host's closed list (`rustdesk`);
 *   the Host builds the link, so a plugin never chooses what starts.
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

import type { RemoteDesktopProviderDefinition } from "@cognia/plugin-contract/lib/remote-desktop/provider-registry"

export function defineRemoteDesktopProvider<const T extends RemoteDesktopProviderDefinition>(
  def: T
): T {
  return def
}
