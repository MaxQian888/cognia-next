import { awaitPending } from "../shared/pending.ts"
import type { PendingEntry } from "../shared/pending.ts"
// `host_rpc` — a request/response channel from the sidecar DIRECTLY to the
// Rust host, over the existing stdio JSON-lines protocol.
//
// Why this exists rather than reusing `plugin_tool_exec`: that frame is
// forwarded to and answered by the RENDERER (see `lib/claude/plugin-tool-ipc.ts`
// and the Companion relay in `crates/cognia-companion-bus/src/event_bus.rs`). A
// renderer-terminated channel cannot serve a headless host, where there is no
// renderer at all, and it pays an extra hop when a remote client is driving.
//
// `host_rpc` is answered by Rust itself in `src-tauri/src/claude/sidecar.rs`
// and never reaches the renderer, so background-job calls work identically on
// the desktop, under `cognia-server`, and when a phone is driving the desktop.
//
// Wire shape:
//   out: { type: "host_rpc",        rpcId, method, params }
//   in:  { type: "host_rpc_result", rpcId, ok, result?, error? }

/** Default ceiling for a single call. Long-polls pass their own. */
export const DEFAULT_HOST_RPC_TIMEOUT_MS = 30_000

/** Margin added to a caller-supplied wait so the host answers before we give up. */
export const HOST_RPC_TIMEOUT_MARGIN_MS = 5_000

/** The frame one call emits toward the host. */
export interface HostRpcRequestFrame {
  type: "host_rpc"
  rpcId: string
  method: string
  params: unknown
}

/** The fields of an inbound `host_rpc_result` frame this client reads. */
interface HostRpcResultFrame {
  rpcId?: unknown
  ok?: unknown
  result?: unknown
  error?: unknown
}

export interface HostRpcOptions {
  emit: (frame: HostRpcRequestFrame) => void
  timeoutMs?: number
}

export interface HostRpcClient {
  /**
   * Issue one call. Resolves with the host's `result`, rejects on `ok: false`,
   * on timeout, or if the channel closes while in flight.
   */
  call(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<unknown>
  /**
   * Settle an in-flight call from an inbound `host_rpc_result` frame and say
   * whether it matched one. Unknown ids are ignored — a late reply after a
   * timeout must not throw.
   */
  resolveResult(msg: unknown): boolean
  /** Fail every in-flight call. Called when the host channel goes away. */
  rejectAll(reason?: unknown): void
  readonly pendingCount: number
  readonly isClosed: boolean
}

/** Create a host-RPC client bound to an `emit` function. */
export function createHostRpc({
  emit,
  timeoutMs = DEFAULT_HOST_RPC_TIMEOUT_MS,
}: HostRpcOptions): HostRpcClient {
  const pending = new Map<string, PendingEntry<unknown>>()
  let seq = 0
  let closed = false

  function call(
    method: string,
    params: unknown,
    options: { timeoutMs?: number } = {}
  ): Promise<unknown> {
    if (closed) {
      return Promise.reject(new Error("host_rpc channel is closed"))
    }
    const rpcId = `rpc-${++seq}`
    const budget = options.timeoutMs ?? timeoutMs
    const promise = awaitPending(pending, rpcId, {
      timeoutMs: budget,
      ref: false,
      exposeReject: true,
      onTimeout: () => {
        throw new Error(`host_rpc ${method} timed out after ${budget} ms`)
      },
    })
    try {
      emit({ type: "host_rpc", rpcId, method, params })
    } catch (error) {
      pending.get(rpcId)?.reject?.(error)
    }
    return promise
  }

  function resolveResult(msg: unknown): boolean {
    const frame = typeof msg === "object" && msg !== null ? (msg as HostRpcResultFrame) : undefined
    const rpcId = typeof frame?.rpcId === "string" ? frame.rpcId : undefined
    const entry = rpcId ? pending.get(rpcId) : undefined
    if (!frame || !rpcId || !entry) return false
    pending.delete(rpcId)
    if (frame.ok === false) {
      entry.reject?.(new Error(String(frame.error ?? "host_rpc failed")))
    } else {
      entry.resolve(frame.result)
    }
    return true
  }

  function rejectAll(reason?: unknown): void {
    closed = true
    const err = new Error(String(reason ?? "host_rpc channel closed"))
    for (const [, entry] of pending) {
      entry.reject?.(err)
    }
    pending.clear()
  }

  return {
    call,
    resolveResult,
    rejectAll,
    get pendingCount() {
      return pending.size
    },
    get isClosed() {
      return closed
    },
  }
}
