import type { PluginToolsServerOptions } from "../../tools/plugin/proxy.ts"
/**
 * Keep the host-only sandbox binding on the plugin-tool bridge envelope.
 * Exported as a pure wiring seam so dispatch tests can prove the field is not
 * dropped before the renderer receives `plugin_tool_exec`.
 */
export function anthropicPluginToolBridgeOptions({
  tools,
  emit,
  sessionId,
  sandboxRuntimeRef,
  pendingPluginToolCalls,
  alwaysLoad,
  alwaysLoadToolNames,
  remoteExecutionContext,
  turnId,
  attemptId,
  toolNameAliases,
  permissionPromptToolName,
}: PluginToolsServerOptions): PluginToolsServerOptions {
  return {
    tools,
    emit,
    sessionId,
    sandboxRuntimeRef,
    pendingPluginToolCalls,
    alwaysLoad,
    alwaysLoadToolNames,
    remoteExecutionContext,
    turnId,
    attemptId,
    permissionPromptToolName,
    ...(toolNameAliases instanceof Map ? { toolNameAliases } : {}),
  }
}
