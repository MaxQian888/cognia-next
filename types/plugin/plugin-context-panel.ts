import type { ComponentType } from "react"
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
export const PLUGIN_CONTEXT_PANEL_ICONS = [
  "blocks",
  "bot",
  "file-text",
  "history",
  "info",
  "message-square",
  "panel-right",
  "play",
  "search-code",
  "settings",
  "wrench",
] as const

export type PluginContextPanelIcon = (typeof PLUGIN_CONTEXT_PANEL_ICONS)[number]

export interface PluginContextPanelDef {
  id: string
  entry: string
  export: string
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
   * Named exports resolved from the same `entry` module as the renderer, so a
   * declarative panel can reach the lifecycle and badge hooks the imperative
   * path already had. Behaviour, not data, which is why they are export names
   * rather than inline values — the manifest itself stays serialisable.
   */
  onFirstActivateExport?: string
  onRestoreExport?: string
  getBadgeExport?: string
  /**
   * Mount the panel inside the resource's chat scope. Costs a provisioned
   * session, so only declare it when the panel renders a conversation.
   */
  requiresChatScope?: boolean
}

export type PluginContextPanelRenderer = ComponentType<ContextPanelRenderProps>
