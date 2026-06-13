// Sandboxed webview panels (B3 of the extension-point expansion). A plugin
// declares `manifest.webviews[]`; each renders arbitrary HTML in an isolated
// `<iframe sandbox="allow-scripts">` (no `allow-same-origin` → opaque origin,
// postMessage-only) mounted into one of the plugin's view containers (B1). The
// CSP injected into the document clamps the frame's egress to the plugin's
// `networkAccess` allowlist. Like VS Code webviews / Figma iframe / Chrome
// side panel.

export type PluginWebviewSurface = "panel" | "window"

export interface PluginWebviewDef {
  /** Stable id, namespaced to the plugin at registration (`<pluginId>:<id>`). */
  id: string
  /** Which view container (B1) this webview mounts into — the container's local id. */
  containerId: string
  /** Optional section title shown above the webview. */
  title?: string
  /** Inline HTML body. Mutually exclusive with `entry`/`export`. */
  html?: string
  /** Relative module path whose `export` is an HTML string or `() => string`. */
  entry?: string
  /** Named export inside `entry`. */
  export?: string
  /** `panel` (iframe in the container, default) or `window` (separate desktop window). */
  surface?: PluginWebviewSurface
  /** Declarative `when` clause (context-key store) gating visibility. */
  when?: string
}

/** A webview resolved by the bridge — HTML wrapped with CSP + the api polyfill. */
export interface ResolvedPluginWebview {
  pluginId: string
  viewId: string
  containerId: string
  title?: string
  when?: string
  surface: PluginWebviewSurface
  /** Full document (`srcDoc`) with CSP meta + `acquireCogniaWebviewApi` polyfill. */
  srcDoc: string
}

/** Message exchanged between the host and a webview iframe. */
export interface PluginWebviewMessage {
  data: unknown
}

/** Imperative handle returned by `ctx.webview.create(...)`. */
export interface PluginWebviewHandle {
  id: string
  /** Push a message into the iframe. Returns false if no frame is attached. */
  postMessage(data: unknown): boolean
  /** Observe messages from the iframe. Returns an unsubscribe. */
  onMessage(listener: (message: PluginWebviewMessage) => void): () => void
  /** Remove the webview. */
  dispose(): void
}
