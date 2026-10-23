/**
 * The plugin contract's share of `lib/remote-desktop/provider-registry.ts`, which re-exports these.
 */
import type { ComponentType } from "react"
import type {
  RemoteDesktopAdapter,
  RemoteDesktopConsoleProfile,
  RemoteDesktopLauncher,
  RemoteDesktopSessionMode,
} from "./types"
import type { RemoteDesktopConnection } from "./stream"

export type RemoteDesktopIntegrationMode = "embedded" | "native" | "web-console" | "external-app"

export type RemoteDesktopViewerStatus = "connecting" | "connected" | "disconnected"

/** What a React viewer is handed for one open session. */
export interface RemoteDesktopViewerProps {
  /**
   * What to connect to: a WebSocket URL carrying a one-shot ticket (open it
   * with the `binary` subprotocol), or an attached channel that is already
   * open. Either carries RFB bytes past authentication. Never persist or log
   * a URL.
   */
  connection: RemoteDesktopConnection
  mode: RemoteDesktopSessionMode
  /** Scale the remote screen to the viewer's box. */
  scaleToFit: boolean
  onStatus: (status: RemoteDesktopViewerStatus) => void
  /** A viewer-side failure, as a stable code (`remote_desktop_viewer_*`). */
  onError: (code: string) => void
  className?: string
}

export type RemoteDesktopViewer =
  | { kind: "react"; component: ComponentType<RemoteDesktopViewerProps> }
  /**
   * A view the plugin registered with `ctx.ui.registerWebview` (or its
   * manifest). The page receives `{ type: "cognia.remote-desktop.port" }` with
   * a transferred `MessagePort`: binary messages are the session's bytes.
   */
  | { kind: "webview"; viewId: string }

export interface RemoteDesktopProviderCapabilities {
  /** The server can enforce a separate view-only password. */
  viewOnlyPassword: boolean
}

export interface RemoteDesktopProviderBase {
  /** Unique within the plugin; lowercase letters, digits, `.`, `_`, `-`. */
  id: string
  /** Display name (already localized by the plugin). */
  name: string
  description?: string
}

/** An in-app viewer over the Host bridge (VNC). */
export interface RemoteDesktopEmbeddedProvider extends RemoteDesktopProviderBase {
  integrationMode: "embedded"
  adapter: RemoteDesktopAdapter
  defaultPort: number
  capabilities: RemoteDesktopProviderCapabilities
  viewer: RemoteDesktopViewer
}

/**
 * The user's own console page (Guacamole, MeshCentral). The user pastes the
 * page that opens the machine; the Host checks it by profile and the client
 * opens it in an isolated webview, never with a credential.
 */
export interface RemoteDesktopWebConsoleProvider extends RemoteDesktopProviderBase {
  integrationMode: "web-console"
  consoleProfile: RemoteDesktopConsoleProfile
  /** An example link for the form (already localized). */
  linkExample?: string
}

/** A local app the client hands the binding's ID to (RustDesk). */
export interface RemoteDesktopExternalAppProvider extends RemoteDesktopProviderBase {
  integrationMode: "external-app"
  launcher: RemoteDesktopLauncher
}

/** Declarable but refused: native viewers are never plugins. */
export interface RemoteDesktopNativeProvider extends RemoteDesktopProviderBase {
  integrationMode: "native"
}

export type RemoteDesktopProviderDefinition =
  | RemoteDesktopEmbeddedProvider
  | RemoteDesktopWebConsoleProvider
  | RemoteDesktopExternalAppProvider
  | RemoteDesktopNativeProvider
