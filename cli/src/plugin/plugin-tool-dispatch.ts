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
import {
  subscribePluginToolDispatchBridge,
  type PluginToolDispatchBridgeDeps,
} from "@/lib/claude/plugin-tool-dispatch-bridge"
import { subscribePluginHookExec, sendPluginHookResponse } from "@/lib/claude/ipc"
import { handlePluginHookExec } from "@/lib/claude/plugin-hook-ipc"
import { loggers } from "@cognia/logging"
import { sandboxSessionRuntime } from "@/lib/sandbox/session-runtime"
import type { UnlistenFn } from "@tauri-apps/api/event"

export interface PluginToolDispatchDeps extends PluginToolDispatchBridgeDeps {
  /** Override the session → sandbox placement lookup. Tests inject here. */
  runtimeRef?: (sessionId: string) => string | undefined
  hooks?: {
    subscribe?: typeof subscribePluginHookExec
    handle?: typeof handlePluginHookExec
    send?: typeof sendPluginHookResponse
  }
}

/**
 * Start forwarding `plugin_tool_exec` events to the executor. Returns a promise
 * for the unsubscribe fn. Each event is handled independently — `handle` never
 * throws (errors are collapsed onto the response), so one bad tool call can't
 * break the subscription.
 */
export async function subscribePluginToolDispatch(
  deps: PluginToolDispatchDeps = {}
): Promise<UnlistenFn> {
  const runtimeRefFor =
    deps.runtimeRef ?? ((sessionId: string) => sandboxSessionRuntime.activeRefForSession(sessionId))
  const stopTools = await subscribePluginToolDispatchBridge({
    ...deps,
    prepareRequest: (request) => {
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
      const bound = request.sandboxRuntimeRef ?? runtimeRefFor(request.sessionId)
      return bound ? { ...request, sandboxRuntimeRef: bound } : request
    },
  })
  try {
    const stopHooks = await subscribeLifecycleHooks(deps)
    return () => {
      stopHooks()
      stopTools()
    }
  } catch (error) {
    stopTools()
    throw error
  }
}

// Share one listener across the parent and its child sessions. The owning
// session answers once; a global owner only handles otherwise unclaimed events.
const hookSubscriptions = new Map<
  typeof subscribePluginHookExec,
  {
    owners: Set<PluginToolDispatchDeps>
    ready?: Promise<() => void>
    calls: Map<string, boolean>
    pending: number
  }
>()

async function subscribeLifecycleHooks(deps: PluginToolDispatchDeps): Promise<UnlistenFn> {
  const subscribe = deps.hooks?.subscribe ?? subscribePluginHookExec
  let state = hookSubscriptions.get(subscribe)
  if (!state) {
    state = { owners: new Set(), calls: new Map(), pending: 0 }
    hookSubscriptions.set(subscribe, state)
  }
  const shared = state
  const forgetIfIdle = () => {
    if (!shared.owners.size && !shared.pending && hookSubscriptions.get(subscribe) === shared)
      hookSubscriptions.delete(subscribe)
  }
  const owner = { ...deps }
  shared.owners.add(owner)
  if (!shared.ready)
    shared.ready = subscribe((request) => {
      const owners = [...shared.owners]
      const selected =
        owners.find((candidate) => candidate.sessionId === request.sessionId) ??
        owners.find((candidate) => !candidate.sessionId)
      if (!selected) return
      const key = JSON.stringify([request.sessionId, request.execId])
      if (shared.calls.has(key)) return
      shared.calls.set(key, false)
      shared.pending++
      void (async () => {
        let outcome
        try {
          outcome = await (selected.hooks?.handle ?? handlePluginHookExec)(request)
        } catch {
          outcome = { error: "Plugin lifecycle hook executor failed" }
        }
        try {
          await (selected.hooks?.send ?? sendPluginHookResponse)({
            sessionId: request.sessionId,
            execId: request.execId,
            ...outcome,
          })
        } catch {
          loggers.app.error("plugin_hook_response write failed", { execId: request.execId })
        } finally {
          shared.pending--
          shared.calls.set(key, true)
          // Match the tool bridge's bounded completed-call retention. In-flight
          // claims cannot be evicted by a burst of completed hooks.
          let completed = [...shared.calls.values()].filter(Boolean).length
          for (const [id, done] of shared.calls) {
            if (completed <= 2048) break
            if (done) {
              shared.calls.delete(id)
              completed--
            }
          }
          forgetIfIdle()
        }
      })()
    })
  let stop: UnlistenFn
  try {
    stop = await shared.ready
  } catch (error) {
    shared.owners.delete(owner)
    shared.ready = undefined
    forgetIfIdle()
    throw error
  }
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    shared.owners.delete(owner)
    if (shared.owners.size) return
    stop()
    shared.ready = undefined
    forgetIfIdle()
  }
}
