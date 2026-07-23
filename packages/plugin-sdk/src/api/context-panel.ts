/** Public contract for trusted React panels in the resource Context Workbench. */

export { defineContextPanel } from "../define/define-context-panel"
/** The safe icon set, for authors enumerating what a rail button may show. */
export { PLUGIN_CONTEXT_PANEL_ICONS } from "@/types/plugin/plugin-context-panel"
export type {
  PluginContextPanelDef,
  PluginContextPanelIcon,
  PluginContextPanelRenderer,
} from "@/types/plugin/plugin-context-panel"
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
