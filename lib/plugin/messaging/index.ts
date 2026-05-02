/**
 * Plugin Messaging - Communication exports
 */

export {
  HookDispatcher,
  PluginLifecycleHooks,
  PluginEventHooks,
  getPluginLifecycleHooks,
  getPluginEventHooks,
  resetPluginLifecycleHooks,
  resetPluginEventHooks,
  normalizePriority,
  priorityToNumber,
  priorityToString,
  HookPriority,
  type HookRegistration,
  type HookSandboxExecutionResult,
  type HookMiddleware,
  type HookExecutionConfig,
} from "./hooks-system"

export {
  PluginIPC,
  getPluginIPC,
  resetPluginIPC,
  createIPCAPI,
  type IPCMessage,
  type IPCRequest,
  type IPCResponse,
  type ExposedMethod,
  type PluginIPCAPI,
} from "./ipc"

export {
  MessageBus,
  getMessageBus,
  resetMessageBus,
  createEventAPI,
  SystemEvents,
  type BusEvent,
  type EventSource,
  type EventFilter,
  type PluginEventAPI,
} from "./message-bus"
