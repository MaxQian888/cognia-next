/** Public contract for trusted React panels in the resource Context Workbench. */

export { defineContextPanel } from "../define/define-context-panel"
export type {
  PluginContextPanelDef,
  PluginContextPanelIcon,
  PluginContextPanelRenderer,
} from "@/types/plugin/plugin-context-panel"
export type {
  PluginContextPanelAPI,
  PluginContextPanelRegistration,
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
} from "@/types/context-workbench"
