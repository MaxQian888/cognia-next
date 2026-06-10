/**
 * Wire the sidecar's `plugin_tool_exec` events to the in-process plugin
 * executor — the CLI counterpart of the desktop's `PluginToolDispatchProvider`.
 *
 * When the model calls a plugin tool, the sidecar's synthetic
 * `cognia-plugin-tools` MCP server proxies it back over the transport as a
 * `plugin_tool_exec` event. We run it through `handlePluginToolExec` (which
 * resolves the tool in the live plugin registry and executes it — the SAME path
 * the desktop uses) and write the result back with `sendPluginToolResponse`.
 *
 * Reuses `lib/claude/ipc` + `lib/claude/plugin-tool-ipc` verbatim over the CLI's
 * StdioTransport (already installed by the sidecar bootstrap). The subscribe /
 * handle / send seams are injectable so the wiring unit-tests without a sidecar.
 */
import { subscribePluginToolExec, sendPluginToolResponse } from "@/lib/claude/ipc"
import {
  handlePluginToolExec,
  type PluginToolExecRequest,
  type PluginToolExecResponse,
} from "@/lib/claude/plugin-tool-ipc"
import type { UnlistenFn } from "@tauri-apps/api/event"

export interface PluginToolDispatchDeps {
  subscribe?: typeof subscribePluginToolExec
  handle?: (req: PluginToolExecRequest) => Promise<PluginToolExecResponse>
  send?: typeof sendPluginToolResponse
}

/**
 * Start forwarding `plugin_tool_exec` events to the executor. Returns a promise
 * for the unsubscribe fn. Each event is handled independently — `handle` never
 * throws (errors are collapsed onto the response), so one bad tool call can't
 * break the subscription.
 */
export function subscribePluginToolDispatch(
  deps: PluginToolDispatchDeps = {}
): Promise<UnlistenFn> {
  const subscribe = deps.subscribe ?? subscribePluginToolExec
  const handle = deps.handle ?? handlePluginToolExec
  const send = deps.send ?? sendPluginToolResponse
  return subscribe((req) => {
    void handle(req as PluginToolExecRequest).then((resp) => send(resp))
  })
}
