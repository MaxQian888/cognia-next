/** Shared sidecar tool round-trip for desktop, CLI and the headless brain. */
import { loggers } from "@cognia/logging"
import { sendPluginToolResponse, subscribePluginToolExec } from "./ipc"
import type { PluginToolExecRequest, PluginToolExecResponse } from "./plugin-tool-ipc"

export interface PluginToolDispatchBridgeDeps {
  sessionId?: string
  subscribe?: typeof subscribePluginToolExec
  handle?: (request: PluginToolExecRequest) => Promise<PluginToolExecResponse>
  send?: typeof sendPluginToolResponse
  prepareRequest?: (request: PluginToolExecRequest) => PluginToolExecRequest
  /** Desktop compatibility check when driving another host. */
  canExecuteRemote?: () => boolean
}

interface DispatchSubscription {
  owners: Set<PluginToolDispatchBridgeDeps>
  ready?: Promise<void>
  unsubscribe?: () => void
  /** Completed ids are bounded; in-flight calls are never evicted. */
  calls: Map<string, boolean>
  pending: number
}

// All production owners use the same IPC source. Session-scoped CLI owners
// share its listener with global owners instead of racing to execute a call.
const subscriptions = new Map<typeof subscribePluginToolExec, DispatchSubscription>()
const MAX_COMPLETED_CALLS = 2048

function callKey(request: PluginToolExecRequest): string {
  const context = request.remoteExecutionContext
  return JSON.stringify([
    context?.hostId,
    context?.originDeviceId,
    context?.generation,
    request.sessionId,
    request.toolUseId,
  ])
}

async function execute(
  request: PluginToolExecRequest,
  owner: PluginToolDispatchBridgeDeps
): Promise<void> {
  const failure = (error: string): PluginToolExecResponse => ({
    type: "plugin_tool_response",
    sessionId: request.sessionId,
    toolUseId: request.toolUseId,
    error,
  })
  let response: PluginToolExecResponse
  try {
    if (request.remoteExecutionContext && owner.canExecuteRemote?.() === false) {
      response = failure("REMOTE_FEATURE_UNSUPPORTED: controller tool proxy is not advertised")
    } else {
      const handle = owner.handle ?? (await import("./plugin-tool-ipc")).handlePluginToolExec
      response = await handle(owner.prepareRequest?.(request) ?? request)
    }
  } catch {
    // Exception messages can contain arguments, credentials or provider bodies.
    // Keep the existing error field useful without reflecting any of that data.
    response = failure("Plugin tool executor failed")
  }
  try {
    await (owner.send ?? sendPluginToolResponse)(response, request.remoteExecutionContext)
  } catch {
    loggers.app.error("plugin_tool_response write failed", { toolUseId: request.toolUseId })
  }
}

/** Acquire the process-wide listener; release only this owner's registration. */
export async function subscribePluginToolDispatchBridge(
  deps: PluginToolDispatchBridgeDeps = {}
): Promise<() => void> {
  const subscribe = deps.subscribe ?? subscribePluginToolExec
  let subscription = subscriptions.get(subscribe)
  if (!subscription) {
    subscription = { owners: new Set(), calls: new Map(), pending: 0 }
    subscriptions.set(subscribe, subscription)
  }
  const state = subscription
  // Each acquisition needs its own identity even if the caller reuses deps.
  const owner = { ...deps }
  state.owners.add(owner)

  const forgetIfIdle = () => {
    if (state.owners.size === 0 && state.pending === 0 && subscriptions.get(subscribe) === state) {
      subscriptions.delete(subscribe)
    }
  }

  if (!state.ready) {
    state.ready = Promise.resolve().then(async () => {
      let listening = true
      const unsubscribe = await subscribe((request) => {
        if (!listening) return
        const owners = [...state.owners]
        const selected =
          owners.find((candidate) => candidate.sessionId === request.sessionId) ??
          owners.find((candidate) => !candidate.sessionId)
        if (!selected) return
        const key = callKey(request)
        if (state.calls.has(key)) return
        state.calls.set(key, false)
        state.pending += 1
        void execute(request, selected).finally(() => {
          state.pending -= 1
          state.calls.set(key, true)
          for (const [completedKey, completed] of state.calls) {
            if (state.calls.size - state.pending <= MAX_COMPLETED_CALLS) break
            if (completed) state.calls.delete(completedKey)
          }
          forgetIfIdle()
        })
      })
      state.unsubscribe = () => {
        listening = false
        unsubscribe()
      }
    })
  }
  try {
    await state.ready
  } catch (error) {
    state.owners.delete(owner)
    state.ready = undefined
    forgetIfIdle()
    throw error
  }

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    state.owners.delete(owner)
    if (state.owners.size > 0) return
    try {
      state.unsubscribe?.()
    } finally {
      state.unsubscribe = undefined
      state.ready = undefined
      // Retain claims while tools drain, including across a quick remount.
      forgetIfIdle()
    }
  }
}
