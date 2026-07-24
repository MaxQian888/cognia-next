/**
 * Plugin SDK — `webview` capability surface.
 *
 * Re-exports the webview authoring helper, registry, and message plumbing for
 * sandboxed plugin webviews.
 */

export { defineWebview } from "../define/define-webview"

export {
  registerWebview,
  unregisterWebviewsByPlugin,
  getWebview,
  getWebviewSnapshot,
  listWebviewsForContainer,
  subscribeWebviews,
  attachWebviewPoster,
  postMessageToWebview,
  dispatchWebviewMessage,
  onWebviewMessage,
} from "@/lib/plugin/registries/webview-registry"

export type {
  PluginWebviewDef,
  PluginWebviewHandle,
  PluginWebviewMessage,
  ResolvedPluginWebview,
} from "@/types/plugin/plugin-webview"

/**
 * The client an author's webview script gets from `acquireCogniaWebviewApi()`
 * (injected into every plugin webview). `setState` is stored host-side — the
 * frame is destroyed whenever its panel unmounts — and replayed into the next
 * frame on load, so `getState()` after acquire returns the previous frame's
 * last save. Runtime-only: state does not survive plugin disable or app
 * restart. `onDidChangeState` fires if a restore lands after acquire.
 */
export interface CogniaWebviewApi {
  postMessage(data: unknown): void
  getState(): unknown
  setState(state: unknown): void
  onDidChangeState(listener: (state: unknown) => void): () => void
}

declare global {
  interface Window {
    acquireCogniaWebviewApi?: () => CogniaWebviewApi
  }
}
