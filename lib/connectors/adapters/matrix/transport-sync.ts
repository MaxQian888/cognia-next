/**
 * Matrix `/sync` long-poll transport.
 *
 * Drives the client-server `/sync` loop via the Tauri HTTP proxy, threading
 * the `next_batch` cursor so each poll only returns events since the last.
 * The very first sync (no `since`) is used only to establish the cursor — its
 * timeline is discarded so the adapter does not replay room history on every
 * cold start. Subsequent polls use the long-poll `timeout` and yield each
 * joined-room timeline event.
 *
 * Backs off exponentially on 5xx / network errors and resets on success,
 * matching the Telegram long-poll transport.
 */

import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { reconnectBackoffMs } from "../_shared/reconnect-backoff"
import { normalizeHomeserver } from "./auth"
import type { MatrixSyncResponse, MatrixTimelineEvent } from "./parse"

const CLIENT_V3 = "/_matrix/client/v3"
const DEFAULT_TIMEOUT_MS = 30_000

export interface MatrixSyncOptions {
  homeserver: string
  accessToken: () => Promise<string>
  signal: AbortSignal
  /** Long-poll timeout sent to the homeserver (ms). Default: 30000. */
  timeoutMs?: number
  /** Override backoff base ms for testing. Default: 1000. */
  _backoffBaseMs?: number
}

export interface MatrixRoomEvent {
  roomId: string
  event: MatrixTimelineEvent
}

/** Delay `ms`; rejects if `signal` fires first. */
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

export async function* startMatrixSync(opts: MatrixSyncOptions): AsyncGenerator<MatrixRoomEvent> {
  const base = normalizeHomeserver(opts.homeserver)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const backoffBaseMs = opts._backoffBaseMs ?? 1000

  let since: string | undefined
  let primed = false
  let attempts = 0

  while (!opts.signal.aborted) {
    const token = await opts.accessToken()
    const params = new URLSearchParams()
    if (since) params.set("since", since)
    // First sync resolves the cursor with no wait; later syncs long-poll.
    params.set("timeout", since ? String(timeoutMs) : "0")
    const url = `${base}${CLIENT_V3}/sync?${params.toString()}`

    try {
      const resp = await connectorsHttpRequest({
        url,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: timeoutMs + 10_000,
      })

      if (resp.status >= 500) throw new Error(`Matrix sync ${resp.status}`)
      const body = JSON.parse(resp.body) as MatrixSyncResponse & { error?: string }
      if (!body.next_batch) throw new Error(`Matrix sync: ${body.error ?? "missing next_batch"}`)

      attempts = 0
      const nextBatch = body.next_batch

      if (primed) {
        const joined = body.rooms?.join ?? {}
        for (const [roomId, room] of Object.entries(joined)) {
          const events = room.timeline?.events ?? []
          for (const event of events) {
            if (opts.signal.aborted) return
            yield { roomId, event }
          }
        }
      } else {
        // Discard the priming batch (recent history) — we only act on events
        // that arrive after the adapter starts.
        primed = true
      }

      since = nextBatch
    } catch (err) {
      if (opts.signal.aborted) return
      if (err instanceof DOMException && err.name === "AbortError") return
      attempts += 1
      const backoffMs = reconnectBackoffMs(backoffBaseMs, attempts)
      try {
        await delay(backoffMs, opts.signal)
      } catch {
        return
      }
    }
  }
}
