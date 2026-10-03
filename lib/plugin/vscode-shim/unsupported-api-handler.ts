/**
 * `vscode:unsupportedApi`: the extension host met API Cognia does not
 * provide (an extension registered a tree view, subscribed to file
 * renames, ...). The reason, from the coverage report the gate generates
 * out of the host's `unsupported.ts`, goes to that extension's log, once per
 * API per host run (the host deduplicates).
 */

import { unsupportedVscodeApiReason } from "./engine-compat"
import { registerMethod, type RpcContext } from "./rpc-dispatcher"
import { appendVscodeLog } from "./vscode-log-buffer"

function handleUnsupportedApi(payload: unknown, context: RpcContext): null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("VS Code RPC payload must be an object")
  }
  const { extensionId, api } = payload as { extensionId?: unknown; api?: unknown }
  if (extensionId !== undefined && extensionId !== context.pluginId) {
    throw new Error(
      `VS Code RPC extension ownership mismatch: ${String(extensionId)} != ${context.pluginId}`
    )
  }
  if (typeof api !== "string" || !api) {
    throw new Error("VS Code RPC payload requires non-empty api")
  }
  const reason = unsupportedVscodeApiReason(api)
  appendVscodeLog(context.pluginId, {
    level: "warn",
    kind: "unsupported-api",
    message: reason
      ? `vscode.${api} is not supported in Cognia: ${reason}`
      : `vscode.${api} is not supported in Cognia.`,
  })
  return null
}

export function installVscodeUnsupportedApiHandler(): Array<() => void> {
  return [registerMethod("vscode:unsupportedApi", handleUnsupportedApi)]
}
