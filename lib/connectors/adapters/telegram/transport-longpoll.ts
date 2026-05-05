/**
 * Telegram getUpdates long-poll transport.
 *
 * Calls the Tauri HTTP wrapper to drive the Bot API getUpdates loop,
 * maintaining the offset cursor. On transient errors backs off exponentially.
 */

import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import type { TelegramUpdate } from "./parse"

export interface LongPollOptions {
  botToken: () => Promise<string>
  /** Default: "https://api.telegram.org" */
  baseUrl?: string
  /** Long-poll timeout sent to Telegram (seconds). Default: 30 */
  timeoutSec?: number
  signal: AbortSignal
  /** Override the backoff base ms for testing. Default: 1000 */
  _backoffBaseMs?: number
}

const DEFAULT_BASE_URL = "https://api.telegram.org"
const DEFAULT_TIMEOUT_SEC = 30

/** Delay `ms` milliseconds; rejects if `signal` fires first. */
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
 * Async generator that calls getUpdates in a loop, yielding each update.
 *
 * Backs off exponentially on 5xx / timeout errors:
 *   waitMs = 1000 * min(2^attempts, 32)
 * Resets attempt counter on a successful poll.
 */
export async function* startLongPoll(opts: LongPollOptions): AsyncGenerator<TelegramUpdate> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC

  const backoffBaseMs = opts._backoffBaseMs ?? 1000

  let offset = 0
  let attempts = 0

  while (!opts.signal.aborted) {
    const token = await opts.botToken()
    const url = `${baseUrl}/bot${token}/getUpdates?offset=${offset}&timeout=${timeoutSec}`

    try {
      const resp = await connectorsHttpRequest({
        url,
        method: "GET",
        timeoutMs: (timeoutSec + 10) * 1000,
      })

      if (resp.status >= 500) {
        throw new Error(`Server error ${resp.status}`)
      }

      const body = JSON.parse(resp.body) as { ok: boolean; result: TelegramUpdate[] }
      if (!body.ok) {
        throw new Error(`Telegram API error: ${resp.body}`)
      }

      attempts = 0
      for (const update of body.result) {
        if (opts.signal.aborted) return
        offset = update.update_id + 1
        yield update
      }
    } catch (err) {
      if (opts.signal.aborted) return
      // Abort errors bubble up immediately
      if (err instanceof DOMException && err.name === "AbortError") return

      attempts += 1
      const backoffMs = backoffBaseMs * Math.min(Math.pow(2, attempts), 32)
      try {
        await delay(backoffMs, opts.signal)
      } catch {
        // Signal fired during backoff — exit cleanly
        return
      }
    }
  }
}
