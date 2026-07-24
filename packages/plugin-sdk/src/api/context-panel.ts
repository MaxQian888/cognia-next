/** Public contract for trusted React panels in the resource Context Workbench. */

export { defineContextPanel } from "../define/define-context-panel"
/** The safe icon set, for authors enumerating what a rail button may show. */
export { PLUGIN_CONTEXT_PANEL_ICONS } from "@/types/plugin/plugin-context-panel"
export type {
  PluginContextPanelDef,
  PluginContextPanelIcon,
  PluginContextPanelRenderer,
  PluginModuleContextPanelDef,
  PluginWebviewContextPanelDef,
} from "@/types/plugin/plugin-context-panel"
export type { ContextPanelWebviewRpcRegistration } from "@/lib/plugin/bridge/context-panel-webview-rpc"
/** Read permission each resource kind is gated on — the same map the host uses. */
export { CONTEXT_RESOURCE_READ_PERMISSIONS } from "@/types/context-workbench"
export type {
  PluginContextPanelAPI,
  PluginContextPanelRegistration,
  PluginContextWorkbenchState,
} from "@/lib/plugin/api/context-panel-api"
export type {
  CanonicalContextActivity,
  ContextActivity,
  ContextCapability,
  ContextPanelMode,
  ContextPanelRenderProps,
  ContextPanelRetention,
  ContextResource,
  ContextResourceKind,
  ContextWorkbenchMode,
} from "@/types/context-workbench"

import type { ContextPanelWebviewRpcRegistration } from "@/lib/plugin/bridge/context-panel-webview-rpc"
import type { PluginContextWorkbenchState } from "@/lib/plugin/api/context-panel-api"
import type {
  ContextPanelMode,
  ContextResource,
  ContextWorkbenchMode,
} from "@/types/context-workbench"

/**
 * The client an author's webview script gets from
 * `acquireCogniaContextPanelApi()` — the host API mirrored over postMessage,
 * so every method is a Promise (5s timeout) and permission checks re-run
 * host-side per call. `onDidChangeVisibility` reports THIS iframe instance's
 * display state, pushed by the panel renderer.
 */
export interface CogniaContextPanelWebviewApi {
  reveal(panelId: string, mode?: ContextPanelMode): Promise<boolean>
  setBadge(panelId: string, count: number): Promise<boolean>
  getActiveContext(): Promise<ContextResource | null>
  getWorkbenchState(): Promise<PluginContextWorkbenchState | null>
  setMode(mode: ContextWorkbenchMode): Promise<boolean>
  setPinned(pinned: boolean): Promise<boolean>
  /** Register another panel, rendered by one of the plugin's declared webviews. */
  register(registration: ContextPanelWebviewRpcRegistration): Promise<string>
  dispose(registrationId: string): Promise<boolean>
  onDidChangeActiveContext(listener: (context: ContextResource | null) => void): () => void
  onDidChangeWorkbenchState(
    listener: (state: PluginContextWorkbenchState | null) => void
  ): () => void
  onDidChangeVisibility(listener: (payload: { visible: boolean }) => void): () => void
}

declare global {
  interface Window {
    /** Present only inside webviews referenced by a `contextPanels[].webview`. */
    acquireCogniaContextPanelApi?: () => CogniaContextPanelWebviewApi
  }
}
