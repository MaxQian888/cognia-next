/**
 * Renderer-side IPC glue for the orchestration proxy round-trip (Thread D4).
 *
 * The Rust `orchestration_proxy` emits an `orchestration-proxy:exec` Tauri
 * event for each sidecar request; the renderer dispatch provider runs the real
 * entry point and posts the result back through the `orchestration_proxy_response`
 * Tauri command. This deliberately uses host-local Tauri APIs instead of the
 * active-host transport: a controller connected to another host must never
 * receive or resolve this bridge request.
 */

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { runOrchestrationExec } from "@/lib/external-bridge/handlers/orchestration"

/** Tauri event the Rust orchestration proxy emits per request. */
export const ORCHESTRATION_EXEC_EVENT = "orchestration-proxy:exec"

export interface OrchestrationExecRequest {
  id: string
  command: string
  args: Record<string, unknown>
}

export interface OrchestrationExecResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface OrchestrationDispatchBridge {
  listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>
}

export interface InstallOrchestrationDispatchOptions {
  bridge?: OrchestrationDispatchBridge
  onError?: (error: unknown) => void
}

/** Subscribe to orchestration exec events. No-op in web. */
export async function subscribeOrchestrationExec(
  handler: (req: OrchestrationExecRequest) => void
): Promise<UnlistenFn> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return () => {}
  }
  return listen<OrchestrationExecRequest>(ORCHESTRATION_EXEC_EVENT, ({ payload }) =>
    handler(payload)
  )
}

/** Post the renderer's reply back to the Rust proxy, resolving the round-trip. */
export async function sendOrchestrationResponse(resp: OrchestrationExecResponse): Promise<void> {
  await invoke("orchestration_proxy_response", {
    id: resp.id,
    ok: resp.ok,
    result: resp.result,
    error: resp.error,
  })
}

function localBridge(): OrchestrationDispatchBridge | undefined {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return undefined
  return {
    listen: (event, handler) => listen(event, handler),
    invoke: (name, args) => invoke(name, args),
  }
}

async function dispatchRequest(
  req: OrchestrationExecRequest,
  bridge: OrchestrationDispatchBridge
): Promise<void> {
  let response: OrchestrationExecResponse
  try {
    response = {
      id: req.id,
      ok: true,
      result: await runOrchestrationExec(req.command, req.args),
    }
  } catch (error) {
    response = {
      id: req.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  await bridge.invoke("orchestration_proxy_response", {
    id: response.id,
    ok: response.ok,
    result: response.result,
    error: response.error,
  })
}

/**
 * Install the shared orchestration request source in either the Desktop
 * renderer or the Headless Brain's injected Companion bridge.
 */
export async function installOrchestrationDispatchSource(
  options: InstallOrchestrationDispatchOptions = {}
): Promise<() => void> {
  const bridge = options.bridge ?? localBridge()
  if (!bridge) return () => undefined
  return bridge.listen<OrchestrationExecRequest>(ORCHESTRATION_EXEC_EVENT, ({ payload }) => {
    void dispatchRequest(payload, bridge).catch((error) => options.onError?.(error))
  })
}
