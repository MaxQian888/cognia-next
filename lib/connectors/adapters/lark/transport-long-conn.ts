/**
 * Lark long-connection transport (TS subscriber).
 *
 * Feishu's long connection speaks a protobuf binary framing over ByteDance's
 * long-conn infra — not the plain-JSON WebSocket an earlier draft assumed. The
 * binary protocol (handshake at `/callback/ws/endpoint`, `pbbp2.Frame` codec,
 * chunk reassembly, gzip, ack, keepalive) lives in Rust
 * (`src-tauri/src/connectors/lark_ws.rs`); this module is the thin TS consumer.
 *
 * It opens the connection via `connectorsLarkWsOpen(adapterId)` (Rust reads
 * appId/appSecret from the keyring), then yields each complete event envelope
 * delivered on `connectors://lark-ws/<handleId>/event`. Rust owns reconnection;
 * the outer loop here only re-opens if Rust signals a terminal `/close` while
 * we haven't been aborted.
 *
 * Returns AsyncGenerator<LarkEventEnvelope> — same shape the adapter expects.
 */

import { listen } from "@tauri-apps/api/event"
import { connectorsLarkWsOpen, connectorsLarkWsClose } from "@/lib/connectors/tauri/commands"
import { loggers } from "@/lib/logging"
import type { LarkEventEnvelope } from "./parse"

export interface LarkLongConnOptions {
  /** Adapter id — Rust reads appId/appSecret from the keyring to handshake. */
  adapterId: string
  signal: AbortSignal
  /** Backoff base ms for the outer re-open loop; default 1000. */
  _backoffBaseMs?: number
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const tid = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(tid)
      reject(new DOMException("Aborted", "AbortError"))
    })
  })
}

/**
 * Start a Lark long-connection generator that yields LarkEventEnvelopes.
 *
 * Re-opens with back-off if the Rust side reports a terminal close; cleans up
 * the listeners and closes the Rust handle on abort.
 */
export async function* startLarkLongConn(
  opts: LarkLongConnOptions
): AsyncGenerator<LarkEventEnvelope> {
  const backoffBaseMs = opts._backoffBaseMs ?? 1000
  let attempts = 0

  while (!opts.signal.aborted) {
    // Open the Rust-side long connection.
    let handleId: string
    try {
      handleId = await connectorsLarkWsOpen(opts.adapterId)
      loggers.network.info("[lark] ws handle opened", {
        adapterId: opts.adapterId,
        handleId,
      })
    } catch (err) {
      if (opts.signal.aborted) return
      attempts += 1
      const backoff = backoffBaseMs * Math.min(Math.pow(2, attempts), 32)
      // Previously swallowed — surface the open failure so a non-connecting
      // bot is diagnosable instead of silently retrying forever.
      loggers.network.warn("[lark] ws open failed, backing off", {
        adapterId: opts.adapterId,
        attempts,
        backoffMs: backoff,
        error: err instanceof Error ? err.message : String(err),
      })
      try {
        await delay(backoff, opts.signal)
      } catch {
        return
      }
      continue
    }

    if (opts.signal.aborted) {
      void connectorsLarkWsClose(handleId).catch(() => {})
      return
    }

    // Queue + wake pattern over the event/close Tauri channels.
    const queue: LarkEventEnvelope[] = []
    let wakeResolve: (() => void) | null = null
    let ended = false

    const unlistenEvent = await listen<string>(
      `connectors://lark-ws/${handleId}/event`,
      (event) => {
        try {
          queue.push(JSON.parse(event.payload) as LarkEventEnvelope)
        } catch {
          return
        }
        wakeResolve?.()
        wakeResolve = null
      }
    )

    const unlistenClose = await listen<void>(`connectors://lark-ws/${handleId}/close`, () => {
      ended = true
      wakeResolve?.()
      wakeResolve = null
    })

    // Only wakes the consume loop so it re-checks `signal.aborted`; the
    // handle is always closed in `finally` (idempotent on the Rust side),
    // which avoids a race where an abort lands before this handler is wired.
    const abortHandler = () => {
      ended = true
      wakeResolve?.()
      wakeResolve = null
    }
    opts.signal.addEventListener("abort", abortHandler)

    try {
      while (!ended && !opts.signal.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            wakeResolve = r
          })
        }
        while (queue.length > 0 && !opts.signal.aborted) {
          attempts = 0 // reset backoff on successful data
          yield queue.shift()!
        }
      }
    } finally {
      opts.signal.removeEventListener("abort", abortHandler)
      unlistenEvent()
      unlistenClose()
      // Always release the Rust handle. `connectors_lark_ws_close` is a no-op
      // when the handle is already gone (terminal /close, double close).
      void connectorsLarkWsClose(handleId).catch(() => {})
    }

    if (opts.signal.aborted) return

    // Rust reported a terminal close without an abort — re-open after back-off.
    attempts += 1
    const backoff = backoffBaseMs * Math.min(Math.pow(2, attempts), 32)
    try {
      await delay(backoff, opts.signal)
    } catch {
      return
    }
  }
}
