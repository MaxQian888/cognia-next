// `host_rpc` — a request/response channel from the sidecar DIRECTLY to the
// Rust host, over the existing stdio JSON-lines protocol.
//
// Why this exists rather than reusing `plugin_tool_exec`: that frame is
// forwarded to and answered by the RENDERER (see `lib/claude/plugin-tool-ipc.ts`
// and the Companion relay in `src-tauri/src/companion_api/event_bus.rs`). A
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

/**
 * Create a host-RPC client bound to an `emit` function.
 *
 * @param {{ emit: (payload: any) => void, timeoutMs?: number }} opts
 */
export function createHostRpc({ emit, timeoutMs = DEFAULT_HOST_RPC_TIMEOUT_MS }) {
  /** @type {Map<string, { resolve: (v: any) => void, reject: (e: Error) => void, timer: any }>} */
  const pending = new Map()
  let seq = 0
  let closed = false

  /**
   * Issue one call. Resolves with the host's `result`, rejects on `ok: false`,
   * on timeout, or if the channel closes while in flight.
   *
   * @param {string} method
   * @param {any} params
   * @param {{ timeoutMs?: number }} [options]
   */
  function call(method, params, options = {}) {
    if (closed) {
      return Promise.reject(new Error("host_rpc channel is closed"))
    }
    const rpcId = `rpc-${++seq}`
    const budget = options.timeoutMs ?? timeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(rpcId)
        reject(new Error(`host_rpc ${method} timed out after ${budget} ms`))
      }, budget)
      // `unref` where available so a pending call cannot hold the process open
      // during shutdown; the drain below is what actually settles it.
      if (typeof timer?.unref === "function") timer.unref()
      pending.set(rpcId, { resolve, reject, timer })
      emit({ type: "host_rpc", rpcId, method, params })
    })
  }

  /**
   * Settle an in-flight call from an inbound `host_rpc_result` frame.
   * Unknown ids are ignored — a late reply after a timeout must not throw.
   *
   * @returns {boolean} whether the frame matched a pending call
   */
  function resolveResult(msg) {
    const entry = msg && msg.rpcId ? pending.get(msg.rpcId) : undefined
    if (!entry) return false
    pending.delete(msg.rpcId)
    clearTimeout(entry.timer)
    if (msg.ok === false) {
      entry.reject(new Error(String(msg.error ?? "host_rpc failed")))
    } else {
      entry.resolve(msg.result)
    }
    return true
  }

  /** Fail every in-flight call. Called when the host channel goes away. */
  function rejectAll(reason) {
    closed = true
    const err = new Error(String(reason ?? "host_rpc channel closed"))
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
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
