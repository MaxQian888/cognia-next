/**
 * The plugin contract's share of `lib/remote-desktop/types.ts`, which re-exports these.
 */
/** The Host handshake adapter a binding uses. Closed list (ADR-0234 §4). */
export type RemoteDesktopAdapter = "vnc" | "none"

/** How a console link is checked. Closed list. */
export type RemoteDesktopConsoleProfile = "guacamole" | "meshcentral" | "generic"

/** External-app launchers the Host can build a link for. Closed list. */
export type RemoteDesktopLauncher = "rustdesk"

export type RemoteDesktopSessionMode = "view" | "control"
