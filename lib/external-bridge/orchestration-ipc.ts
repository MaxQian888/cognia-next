/**
 * Renderer-side IPC glue for the orchestration proxy round-trip (Thread D4).
 *
 * The Rust `orchestration_proxy` emits an `orchestration-proxy:exec` Tauri
 * event for each sidecar request; the renderer dispatch provider runs the real
 * entry point and posts the result back through the `orchestration_proxy_response`
 * Tauri command. Both wrap `@/lib/tauri`'s `transport` (no-op in web), mirroring
 * `subscribePluginToolExec` / `sendPluginToolResponse` in `lib/claude/ipc.ts`.
 */

import type { UnlistenFn } from "@tauri-apps/api/event"
import { transport } from "@/lib/tauri"

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
  return transport.subscribe<OrchestrationExecRequest>(ORCHESTRATION_EXEC_EVENT, handler)
}

/** Post the renderer's reply back to the Rust proxy, resolving the round-trip. */
export async function sendOrchestrationResponse(resp: OrchestrationExecResponse): Promise<void> {
  await transport.call("orchestration_proxy_response", {
    id: resp.id,
    ok: resp.ok,
    result: resp.result,
    error: resp.error,
  })
}
