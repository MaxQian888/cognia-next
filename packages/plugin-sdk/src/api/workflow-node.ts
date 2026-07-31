/**
 * Plugin SDK - `workflow-node` capability surface.
 *
 * Re-exports the node authoring helper and workflow node executor registry
 * used by built-in nodes, plugin nodes, the editor catalog, and orchestrator.
 */

export { defineWorkflowNode } from "../define/define-workflow-node"

export {
  BUILTIN_PLUGIN_ID,
  getExecutor,
  listRegisteredKinds,
  registerNodeExecutor,
  subscribeNodeRegistry,
  unregisterNodeExecutor,
} from "@/lib/workflow/nodes/registry"

export type {
  NodeExecuteFn,
  NodeExecutorRegistration,
  NodeRegistryEvent,
  NodeRegistryListener,
} from "@/lib/workflow/nodes/registry"

export type { PluginNodeDef, PluginNodeExecuteFn } from "@/types/plugin/plugin-workflow"
