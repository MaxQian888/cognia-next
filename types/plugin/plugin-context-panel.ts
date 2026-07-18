import type { ComponentType } from "react"
import type {
  CanonicalContextActivity,
  ContextCapability,
  ContextPanelMode,
  ContextPanelRenderProps,
  ContextPanelRetention,
  ContextResourceKind,
} from "@/types/context-workbench"

export type PluginContextPanelIcon =
  | "blocks"
  | "bot"
  | "file-text"
  | "history"
  | "info"
  | "message-square"
  | "panel-right"
  | "play"
  | "search-code"
  | "settings"
  | "wrench"

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
}

export type PluginContextPanelRenderer = ComponentType<ContextPanelRenderProps>
