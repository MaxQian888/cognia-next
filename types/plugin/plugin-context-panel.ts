import type { ComponentType } from "react"
import type { PluginIconName } from "./plugin-icon"
import type {
  CanonicalContextActivity,
  ContextCapability,
  ContextPanelMode,
  ContextPanelRenderProps,
  ContextPanelRetention,
  ContextResourceKind,
} from "@/types/context-workbench"

/**
 * Icon names a contributed panel may name for its activity-rail button.
 *
 * A runtime array for the same reason `CANONICAL_CONTEXT_ACTIVITIES` and
 * `CONTEXT_RESOURCE_READ_PERMISSIONS` are: this list was hand-copied into three
 * places — this union, the host's name→component map, and the manifest
 * validator's allowlist — and only two of them were checked against each other.
 * Names only, so the validator never has to pull `lucide-react` in.
 */
/** @deprecated Use `PluginIconName`; kept as a source-compatible alias. */
export type PluginContextPanelIcon = PluginIconName

interface PluginContextPanelDefBase {
  id: string
  resourceKinds: ContextResourceKind[]
  activity: CanonicalContextActivity
  labelKey: string
  label: string
  icon?: PluginContextPanelIcon
  order?: number
  requiredCapabilities?: ContextCapability[]
  preferredMode?: ContextPanelMode
  retention?: ContextPanelRetention
  /**
   * Mount the panel inside the resource's chat scope. Costs a provisioned
   * session, so only declare it when the panel renders a conversation.
   */
  requiresChatScope?: boolean
}

/** Panel backed by a JS module: `entry`'s `export` is the React renderer. */
export interface PluginModuleContextPanelDef extends PluginContextPanelDefBase {
  entry: string
  export: string
  /**
   * Named exports resolved from the same `entry` module as the renderer, so a
   * declarative panel can reach the lifecycle and badge hooks the imperative
   * path already had. Behaviour, not data, which is why they are export names
   * rather than inline values — the manifest itself stays serialisable.
   */
  onFirstActivateExport?: string
  onRestoreExport?: string
  getBadgeExport?: string
  webview?: never
}

/**
 * Panel backed by a sandboxed webview: `webview` names an entry of the same
 * manifest's `webviews[]`. The host renders that webview's iframe as the panel
 * body and mirrors the context-panel API into it over postMessage
 * (`acquireCogniaContextPanelApi()`), so there is no module to resolve
 * lifecycle exports from — hence the `never` fields.
 */
export interface PluginWebviewContextPanelDef extends PluginContextPanelDefBase {
  webview: string
  entry?: never
  export?: never
  onFirstActivateExport?: never
  onRestoreExport?: never
  getBadgeExport?: never
}

export type PluginContextPanelDef = PluginModuleContextPanelDef | PluginWebviewContextPanelDef

export type PluginContextPanelRenderer = ComponentType<ContextPanelRenderProps>
