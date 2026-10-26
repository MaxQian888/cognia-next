/**
 * Plugin SDK — `workspace-backend` capability surface.
 *
 * Exports the authoring helper, the types of `ctx.workspace`, and the host
 * workspace-backend registry used by plugin-contributed execution backends.
 * The host builds `ctx.workspace` and registers manifest-declared backends
 * itself.
 */

export { defineWorkspaceBackend } from "../define/define-workspace-backend"

export type {
  WorkspaceBackendBridgeError,
  WorkspaceBackendBridgeOptions,
  WorkspaceBackendBridgeResult,
} from "@cognia/plugin-contract/lib/plugin/bridge/workspace-backend-bridge"

export type { PluginWorkspaceAPI } from "@cognia/plugin-contract/lib/plugin/api/workspace-api"

export {
  clearWorkspaceBackendsForPlugin,
  getWorkspaceBackend,
  hasWorkspaceBackend,
  listWorkspaceBackends,
  registerWorkspaceBackend,
  subscribeWorkspaceBackendRegistry,
  unregisterWorkspaceBackend,
} from "@cognia/plugin-contract/lib/github/workspace-backend-registry"

export type {
  WorkspaceBackendRegistration,
  WorkspaceBackendRegistryEvent,
} from "@cognia/plugin-contract/lib/github/workspace-backend-registry"

export type {
  PluginWorkspaceBackendDef,
  PluginWorkspaceBackendFactory,
  PluginWorkspaceBackendFactoryContext,
  PluginWorkspaceBackendRegistration,
  WorkspaceProvider,
} from "@cognia/plugin-contract/types/plugin/plugin-workspace-backend"
