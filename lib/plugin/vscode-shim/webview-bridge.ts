/**
 * Webview bridge for the VS Code reuse layer.
 *
 * `vscode.window.createWebviewPanel(viewType, title, showOptions, options)`
 * and `vscode.window.registerWebviewViewProvider(viewType, provider)` both
 * mint a Webview-shaped object that the extension talks to via:
 *
 *   - `webview.html = "..."` to set the iframe document
 *   - `webview.postMessage(msg)` to push messages into the iframe
 *   - `webview.onDidReceiveMessage(listener)` to observe messages from the iframe
 *   - `webview.asWebviewUri(uri)` to convert file:// paths to a safe scheme
 *   - `panel.onDidChangeViewState(listener)` to observe show/hide events
 *
 * The cognia renderer doesn't ship a raw iframe sandbox just for VS Code —
 * we reuse the existing `components/artifacts/artifact-preview.tsx` iframe
 * sandbox via a thin adapter (`HostFrame`). This module is the cognia-side
 * state machine: it tracks every panel, fans messages in/out, polyfills
 * `acquireVsCodeApi()`, and supports view-state retention so a webview
 * survives a navigate-away/-back without losing its DOM state.
 *
 * The actual iframe component lives in
 * `components/extensions/vscode-extension-panel.tsx` (M1.C). It calls
 * `attachHostFrame(panelId, frame)` once the iframe mounts.
 */

import { nanoid } from "nanoid"

export interface WebviewMessage {
  /** Free-form payload — VS Code requires JSON-serialisable. */
  data: unknown
}

export interface WebviewPanelOptions {
  enableScripts?: boolean
  enableForms?: boolean
  enableCommandUris?: boolean
  /** File system roots the webview is allowed to load resources from. */
  localResourceRoots?: string[]
  /** Restore the webview's serialised state on next mount. */
  retainContextWhenHidden?: boolean
  /** Strict CSP source allow-list. */
  portMapping?: Array<{ webviewPort: number; extensionHostPort: number }>
}

export type WebviewPanelType = "panel" | "view"

export interface CreateWebviewRequest {
  extensionId: string
  viewType: string
  title: string
  type: WebviewPanelType
  /** Initial sidebar/activity-bar id when `type === "view"`. */
  hostSlot?: "sidebar.left" | "sidebar.right" | "panel.bottom"
  options: WebviewPanelOptions
  /** Initial HTML body. Can be replaced via setHtml. */
  initialHtml: string
}

export interface ViewStateChangeEvent {
  panelId: string
  visible: boolean
  active: boolean
}

/**
 * Bridge from cognia's iframe component to the bridge. The component
 * provides three primitives the bridge needs:
 *   - `setSrcDoc(html)` — replace the iframe document.
 *   - `post(message)` — postMessage into the iframe.
 *   - `onMessage(listener)` — observe iframe → host messages.
 */
export interface HostFrame {
  panelId: string
  setSrcDoc(html: string): void
  post(message: WebviewMessage): void
  onMessage(listener: (message: WebviewMessage) => void): () => void
  /** Best-effort destroy — unmounts the iframe. */
  destroy(): void
}

export interface WebviewRecord {
  panelId: string
  extensionId: string
  viewType: string
  title: string
  type: WebviewPanelType
  hostSlot?: CreateWebviewRequest["hostSlot"]
  options: WebviewPanelOptions
  /** Current HTML — held even when no HostFrame is attached so we can
   * re-emit on remount (retainContextWhenHidden / lazy view providers). */
  html: string
  /** Serialised state — VS Code allows `webview.setState(value)` from the
   * client; we round-trip it through `webview-bridge` so the next mount
   * sees the same state via `vscode.getState()`. */
  state: unknown
  visible: boolean
  active: boolean
  disposed: boolean
}

const panels = new Map<string, WebviewRecord>()
const frames = new Map<string, HostFrame>()
const frameMessageListeners = new Map<string, () => void>()
const messageListenersForPanel = new Map<string, Set<(msg: WebviewMessage) => void>>()
const viewStateListeners = new Map<string, Set<(event: ViewStateChangeEvent) => void>>()
const disposeListeners = new Map<string, Set<() => void>>()

let resourceUriRoot = "cognia-webview://"

export function setResourceUriRoot(root: string): void {
  resourceUriRoot = root
}

// ────────────────────────────────────────────────────────────────────────
// Panel CRUD
// ────────────────────────────────────────────────────────────────────────

export function createWebviewPanel(req: CreateWebviewRequest): WebviewRecord {
  const panelId = nanoid()
  const record: WebviewRecord = {
    panelId,
    extensionId: req.extensionId,
    viewType: req.viewType,
    title: req.title,
    type: req.type,
    hostSlot: req.hostSlot,
    options: req.options,
    html: req.initialHtml,
    state: undefined,
    visible: true,
    active: true,
    disposed: false,
  }
  panels.set(panelId, record)
  return record
}

export function getPanel(panelId: string): WebviewRecord | undefined {
  return panels.get(panelId)
}

export function listPanels(): WebviewRecord[] {
  return [...panels.values()]
}

export function listPanelsByExtension(extensionId: string): WebviewRecord[] {
  return [...panels.values()].filter((p) => p.extensionId === extensionId)
}

export function disposeWebviewPanel(panelId: string): boolean {
  const record = panels.get(panelId)
  if (!record || record.disposed) return false
  record.disposed = true
  // Notify dispose listeners synchronously — VS Code spec.
  const listeners = disposeListeners.get(panelId)
  if (listeners) {
    for (const fn of listeners) {
      try {
        fn()
      } catch (err) {
        console.warn(`webview-bridge: dispose listener threw for ${panelId}:`, err)
      }
    }
  }
  // Tear down the iframe if one is attached.
  const frame = frames.get(panelId)
  if (frame) {
    try {
      frame.destroy()
    } catch (err) {
      console.warn(`webview-bridge: frame.destroy() threw for ${panelId}:`, err)
    }
  }
  detachHostFrame(panelId)
  panels.delete(panelId)
  return true
}

export function disposeWebviewPanelsByExtension(extensionId: string): number {
  let removed = 0
  for (const [id, record] of panels) {
    if (record.extensionId === extensionId) {
      if (disposeWebviewPanel(id)) removed += 1
    }
  }
  return removed
}

// ────────────────────────────────────────────────────────────────────────
// Panel content + state
// ────────────────────────────────────────────────────────────────────────

export function setHtml(panelId: string, html: string): void {
  const record = panels.get(panelId)
  if (!record || record.disposed) return
  record.html = html
  const frame = frames.get(panelId)
  if (frame) frame.setSrcDoc(html)
}

export function setTitle(panelId: string, title: string): void {
  const record = panels.get(panelId)
  if (!record || record.disposed) return
  record.title = title
}

export function getState(panelId: string): unknown {
  return panels.get(panelId)?.state
}

export function setState(panelId: string, state: unknown): void {
  const record = panels.get(panelId)
  if (!record || record.disposed) return
  record.state = state
}

// ────────────────────────────────────────────────────────────────────────
// Messaging
// ────────────────────────────────────────────────────────────────────────

/**
 * Push a message from the extension into the webview iframe.
 * Buffered when no frame is attached yet — the next attach replays the
 * stored html (state restoration), but messages sent while detached are
 * silently dropped, matching VS Code semantics for hidden panels without
 * retainContextWhenHidden.
 */
export function postMessageToWebview(panelId: string, data: unknown): boolean {
  const record = panels.get(panelId)
  if (!record || record.disposed) return false
  const frame = frames.get(panelId)
  if (!frame) return false
  try {
    frame.post({ data })
    return true
  } catch (err) {
    console.warn(`webview-bridge: post() threw for ${panelId}:`, err)
    return false
  }
}

export function onDidReceiveMessage(
  panelId: string,
  listener: (msg: WebviewMessage) => void
): () => void {
  let set = messageListenersForPanel.get(panelId)
  if (!set) {
    set = new Set()
    messageListenersForPanel.set(panelId, set)
  }
  set.add(listener)
  return () => set!.delete(listener)
}

export function onDidChangeViewState(
  panelId: string,
  listener: (event: ViewStateChangeEvent) => void
): () => void {
  let set = viewStateListeners.get(panelId)
  if (!set) {
    set = new Set()
    viewStateListeners.set(panelId, set)
  }
  set.add(listener)
  return () => set!.delete(listener)
}

export function onDidDispose(panelId: string, listener: () => void): () => void {
  let set = disposeListeners.get(panelId)
  if (!set) {
    set = new Set()
    disposeListeners.set(panelId, set)
  }
  set.add(listener)
  return () => set!.delete(listener)
}

/**
 * Convert a file:// or extension-relative URI into a scheme the webview
 * iframe is allowed to load. Mirrors `webview.asWebviewUri(uri)`.
 */
export function asWebviewUri(uri: string): string {
  if (uri.startsWith(resourceUriRoot)) return uri
  return `${resourceUriRoot}${encodeURIComponent(uri)}`
}

/**
 * The CSP source string the webview's `<meta http-equiv="Content-Security-Policy">`
 * should allow. Cognia returns a tight CSP — VS Code-mirror semantics.
 */
export function getCspSource(): string {
  return resourceUriRoot
}

// ────────────────────────────────────────────────────────────────────────
// HostFrame attachment (called by the React component when iframe mounts)
// ────────────────────────────────────────────────────────────────────────

export function attachHostFrame(panelId: string, frame: HostFrame): void {
  const record = panels.get(panelId)
  if (!record || record.disposed) {
    try {
      frame.destroy()
    } catch {
      /* swallow */
    }
    return
  }
  // Tear down any previous frame attached to the same panel.
  detachHostFrame(panelId)
  frames.set(panelId, frame)
  // Replay current html into the iframe.
  try {
    frame.setSrcDoc(record.html)
  } catch (err) {
    console.warn(`webview-bridge: initial setSrcDoc() threw for ${panelId}:`, err)
  }
  // Wire iframe → host listener.
  const unlisten = frame.onMessage((msg) => {
    const set = messageListenersForPanel.get(panelId)
    if (!set) return
    for (const listener of set) {
      try {
        listener(msg)
      } catch (err) {
        console.warn(`webview-bridge: message listener threw for ${panelId}:`, err)
      }
    }
  })
  frameMessageListeners.set(panelId, unlisten)
}

export function detachHostFrame(panelId: string): void {
  const unlisten = frameMessageListeners.get(panelId)
  if (unlisten) {
    try {
      unlisten()
    } catch (err) {
      console.warn(`webview-bridge: detach unlisten threw for ${panelId}:`, err)
    }
    frameMessageListeners.delete(panelId)
  }
  frames.delete(panelId)
}

export function notifyViewStateChange(panelId: string, visible: boolean, active: boolean): void {
  const record = panels.get(panelId)
  if (!record || record.disposed) return
  if (record.visible === visible && record.active === active) return
  record.visible = visible
  record.active = active
  const set = viewStateListeners.get(panelId)
  if (!set) return
  for (const listener of set) {
    try {
      listener({ panelId, visible, active })
    } catch (err) {
      console.warn(`webview-bridge: viewstate listener threw for ${panelId}:`, err)
    }
  }
}

/**
 * Inject text the iframe's `<script>` block can call as
 * `acquireVsCodeApi()` to get a polyfilled VS Code Webview API.
 *
 * Returns the JS source the host frame splices into the served HTML.
 */
export function acquireVsCodeApiPolyfillSource(): string {
  return `
    (function () {
      let nonce = false;
      let lastState = undefined;
      window.acquireVsCodeApi = function () {
        if (nonce) throw new Error("acquireVsCodeApi() can only be called once.");
        nonce = true;
        return {
          postMessage: function (data) {
            window.parent.postMessage({ __cogniaWebviewKind: "post", data }, "*");
          },
          getState: function () { return lastState; },
          setState: function (state) {
            lastState = state;
            window.parent.postMessage({ __cogniaWebviewKind: "set-state", state }, "*");
          },
        };
      };
    }());
  `
}

export function __resetWebviewBridgeForTesting(): void {
  panels.clear()
  frames.clear()
  frameMessageListeners.clear()
  messageListenersForPanel.clear()
  viewStateListeners.clear()
  disposeListeners.clear()
  resourceUriRoot = "cognia-webview://"
}
