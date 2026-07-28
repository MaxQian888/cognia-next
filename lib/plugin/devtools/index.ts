/**
 * Plugin Developer Tools - Exports
 */

export {
  PluginDevTools,
  setDebugMode,
  isDebugEnabled,
  debugLog,
  getDebugLogs,
  clearDebugLogs,
  inspectPlugin,
  inspectAllPlugins,
  createMockPluginContext,
  validateManifestStrict,
} from "./dev-tools"

export {
  PluginDebugger,
  getPluginDebugger,
  resetPluginDebugger,
  type DebugSession,
  type Breakpoint,
  type CallFrame,
  type WatchExpression,
  type LogEntry,
} from "./debugger"

export {
  PluginProfiler,
  getPluginProfiler,
  resetPluginProfiler,
  withProfiling,
  type ProfileEntry,
  type ProfileSummary,
  type FlameNode,
  type ResourceUsage,
} from "./profiler"

export {
  PluginHotReload,
  getPluginHotReload,
  resetPluginHotReload,
  type HotReloadConfig,
  type FileChangeEvent,
  type ReloadResult,
} from "./hot-reload"
export { usePluginHotReload } from "./hot-reload.client"

export { DevExtensionController, type DevExtensionRecord } from "./dev-extension-controller"

export {
  PluginDevServer,
  getPluginDevServer,
  resetPluginDevServer,
  type DevServerConfig,
  type DevServerStatus,
  type DevConsoleMessage,
  type PluginBuildResult,
} from "./dev-server"
export { usePluginDevServer } from "./dev-server.client"

export {
  ManagedIdeDevMode,
  type ManagedIdeDevModeDependencies,
  type ManagedIdeManifestDiagnostic,
} from "./managed-ide-dev-mode"
