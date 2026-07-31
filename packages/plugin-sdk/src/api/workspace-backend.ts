/**
 * Plugin SDK — `workspace-backend` capability surface.
 *
 * Re-exports the authoring helper, manifest bridge, plugin context API, and
 * host workspace-backend registry used by plugin-contributed execution
 * backends.
 */

export { defineWorkspaceBackend } from "../define/define-workspace-backend"

export {
  registerWorkspaceBackendsForPlugin,
  unregisterWorkspaceBackendsForPlugin,
} from "@/lib/plugin/bridge/workspace-backend-bridge"

export type {
  WorkspaceBackendBridgeError,
  WorkspaceBackendBridgeOptions,
  WorkspaceBackendBridgeResult,
} from "@/lib/plugin/bridge/workspace-backend-bridge"

export {
  clearWorkspaceBackendsForPluginContext,
  createWorkspaceAPI,
} from "@/lib/plugin/api/workspace-api"

export type { PluginWorkspaceAPI } from "@/lib/plugin/api/workspace-api"

export {
  clearWorkspaceBackendsForPlugin,
  getWorkspaceBackend,
  hasWorkspaceBackend,
  listWorkspaceBackends,
  registerWorkspaceBackend,
  subscribeWorkspaceBackendRegistry,
  unregisterWorkspaceBackend,
} from "@/lib/github/workspace-backend-registry"

export type {
  WorkspaceBackendRegistration,
  WorkspaceBackendRegistryEvent,
} from "@/lib/github/workspace-backend-registry"

export type {
  PluginWorkspaceBackendDef,
  PluginWorkspaceBackendFactory,
  PluginWorkspaceBackendFactoryContext,
  PluginWorkspaceBackendRegistration,
  WorkspaceProvider,
} from "@/types/plugin/plugin-workspace-backend"
