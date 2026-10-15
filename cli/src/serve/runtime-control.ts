/**
 * The brain's half of per-runtime restart (ADR-0059 W2).
 *
 * The server asks over the bridge with `companion://runtime-control-request`
 * (`crates/cognia-companion/src/runtime_control.rs`), on behalf of the
 * `host_runtime_list` and `host_runtime_restart` commands; this answers with
 * the runtimes' states, and for a restart, the restarted runtime's. A request
 * the brain cannot act on is answered with an error code rather than left to
 * time out.
 */
import {
  HeadlessRuntimeControlError,
  type BootstrapResult,
  type HeadlessRuntimeStatus,
} from "@/lib/headless/bootstrap"
import type { RuntimeBridge } from "@/lib/headless/types"

export const RUNTIME_CONTROL_REQUEST_EVENT = "companion://runtime-control-request"
export const RUNTIME_CONTROL_RESPONSE_COMMAND = "companion_runtime_control_response"

export interface RuntimeControlAnswer {
  requestId: string
  runtimes?: HeadlessRuntimeStatus[]
  /** The runtime a restart acted on, as it is afterwards. */
  runtime?: HeadlessRuntimeStatus
  error?: { code: string; message: string }
}

type Runtimes = Pick<BootstrapResult, "status" | "restart">

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

/** Answer one request. Exported for tests; the listener below calls it. */
export async function answerRuntimeControl(
  payload: unknown,
  runtimes: Runtimes
): Promise<RuntimeControlAnswer | null> {
  const request = object(payload)
  const requestId = typeof request.request_id === "string" ? request.request_id : ""
  if (!requestId) return null
  const fail = (code: string, message: string): RuntimeControlAnswer => ({
    requestId,
    error: { code, message },
  })
  switch (request.action) {
    case "list":
      return { requestId, runtimes: runtimes.status() }
    case "restart": {
      const name = typeof request.name === "string" ? request.name.trim() : ""
      if (!name) return fail("invalid_argument", "a restart names the runtime")
      try {
        const runtime = await runtimes.restart(name)
        return { requestId, runtime, runtimes: runtimes.status() }
      } catch (error) {
        if (error instanceof HeadlessRuntimeControlError) return fail(error.code, error.message)
        return fail(
          "runtime_control_failed",
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    default:
      return fail("invalid_argument", `unknown runtime control action: ${String(request.action)}`)
  }
}

/** Listen for the server's requests until the returned function is called. */
export function installRuntimeControl(
  bridge: Pick<RuntimeBridge, "listen" | "invoke">,
  runtimes: Runtimes,
  log: (level: "info" | "warn" | "error", message: string) => void
): Promise<() => void> {
  return bridge.listen<unknown>(RUNTIME_CONTROL_REQUEST_EVENT, ({ payload }) => {
    void answerRuntimeControl(payload, runtimes)
      .then(async (answer) => {
        if (!answer) {
          log("warn", "runtime control request without a request id; ignored")
          return
        }
        await bridge.invoke(RUNTIME_CONTROL_RESPONSE_COMMAND, { ...answer })
      })
      .catch((error: unknown) => {
        log(
          "error",
          `runtime control answer failed: ${error instanceof Error ? error.message : String(error)}`
        )
      })
  })
}
