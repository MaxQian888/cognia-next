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
import { sandboxSessionRuntime } from "@/lib/sandbox/session-runtime"
import type { UnlistenFn } from "@tauri-apps/api/event"

export interface PluginToolDispatchDeps {
  subscribe?: typeof subscribePluginToolExec
  handle?: (req: PluginToolExecRequest) => Promise<PluginToolExecResponse>
  send?: typeof sendPluginToolResponse
  /** Override the session → sandbox placement lookup. Tests inject here. */
  runtimeRef?: (sessionId: string) => string | undefined
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
  const runtimeRefFor =
    deps.runtimeRef ?? ((sessionId: string) => sandboxSessionRuntime.activeRefForSession(sessionId))
  return subscribe((req) => {
    // The CLI rail has no send envelope to carry the placement, so the frame
    // arrives without `sandboxRuntimeRef`. The runtime service bound one for
    // this session id from its persisted sandbox ceiling; stamp it here so
    // headless `sandbox_*` calls clamp to that ceiling instead of falling back
    // to an unpoliced host tier.
    //
    // The stamp is deliberately not scoped to the sandbox tools: the ref also
    // carries the GUI placement, and the CLI binds `computerTarget: "local"`
    // with Computer Use enabled — the host/local placement those tools already
    // ran under. A ref that declared the GUI surface disabled would turn every
    // `perform_action` on this rail into a refusal instead.
    const request = req as PluginToolExecRequest
    const bound = request.sandboxRuntimeRef ?? runtimeRefFor(request.sessionId)
    void handle(bound ? { ...request, sandboxRuntimeRef: bound } : request).then((resp) =>
      send(resp)
    )
  })
}
