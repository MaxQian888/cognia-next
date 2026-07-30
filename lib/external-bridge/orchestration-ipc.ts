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
