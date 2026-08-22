/**
 * Telegram getUpdates long-poll transport.
 *
 * Calls the Tauri HTTP wrapper to drive the Bot API getUpdates loop,
 * maintaining the offset cursor. On transient errors backs off exponentially
 * (honouring Telegram's explicit 429 `retry_after` when it is longer) and
 * reports every failure/success to the adapter via `onPollError` /
 * `onPollSuccess` so persistent failures (401 invalid token, 409 conflict)
 * can degrade the adapter's health instead of retrying invisibly forever.
 */

import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { reconnectBackoffMs } from "../_shared/reconnect-backoff"
import type { TelegramUpdate } from "./parse"

export interface PollErrorInfo {
  /** HTTP status or Telegram `error_code` when one was available. */
  status?: number
  /** Telegram-declared cool-down (ms) from `parameters.retry_after`. */
  retryAfterMs?: number
  message: string
}

export interface LongPollOptions {
  botToken: () => Promise<string>
  /** Default: "https://api.telegram.org" */
  baseUrl?: string
  /** Long-poll timeout sent to Telegram (seconds). Default: 30 */
  timeoutSec?: number
  signal: AbortSignal
  /** Override the backoff base ms for testing. Default: 1000 */
  _backoffBaseMs?: number
  /** Invoked after every failed poll with classification info. */
  onPollError?: (info: PollErrorInfo) => void
  /** Invoked after every successful poll (clears degraded health upstream). */
  onPollSuccess?: () => void
}

const DEFAULT_BASE_URL = "https://api.telegram.org"
const DEFAULT_TIMEOUT_SEC = 30

/**
 * Update types we ask Telegram to deliver.
 *
 * The list is EXPLICIT, so Telegram's own defaults do not apply: anything not
 * named here is silently never delivered. Bot API 7.0's `message_reaction` was
 * the first casualty (audited fix #3); `my_chat_member` was the second — it is
 * in Telegram's default set, but naming any list at all opts out of that set,
 * so the bot never learned it had been added to or removed from a chat.
 */
const ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "callback_query",
  "message_reaction",
  "my_chat_member",
] as const

/** Poll failure carrying the HTTP / Bot-API status for classification. */
class LongPollError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = "LongPollError"
  }
}

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
 *   waitMs = max(1000 * min(2^attempts, 32), telegram retry_after)
 * Resets attempt counter on a successful poll.
 */
export async function* startLongPoll(opts: LongPollOptions): AsyncGenerator<TelegramUpdate> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC

  const backoffBaseMs = opts._backoffBaseMs ?? 1000
  const allowedUpdates = encodeURIComponent(JSON.stringify(ALLOWED_UPDATES))

  let offset = 0
  let attempts = 0

  while (!opts.signal.aborted) {
    const token = await opts.botToken()
    const url = `${baseUrl}/bot${token}/getUpdates?offset=${offset}&timeout=${timeoutSec}&allowed_updates=${allowedUpdates}`

    try {
      const resp = await connectorsHttpRequest({
        url,
        method: "GET",
        timeoutMs: (timeoutSec + 10) * 1000,
      })

      if (resp.status >= 500) {
        throw new LongPollError(`Server error ${resp.status}`, resp.status)
      }

      const body = JSON.parse(resp.body) as {
        ok: boolean
        result?: TelegramUpdate[]
        description?: string
        error_code?: number
        parameters?: { retry_after?: number }
      }
      if (!body.ok) {
        const status = body.error_code ?? resp.status
        const retryAfterMs =
          typeof body.parameters?.retry_after === "number"
            ? body.parameters.retry_after * 1000
            : undefined
        throw new LongPollError(
          `Telegram API error: ${body.description ?? resp.body}`,
          status,
          retryAfterMs
        )
      }

      attempts = 0
      opts.onPollSuccess?.()
      for (const update of body.result ?? []) {
        if (opts.signal.aborted) return
        offset = update.update_id + 1
        yield update
      }
    } catch (err) {
      if (opts.signal.aborted) return
      // Abort errors bubble up immediately
      if (err instanceof DOMException && err.name === "AbortError") return

      attempts += 1
      const status = err instanceof LongPollError ? err.status : undefined
      const retryAfterMs = err instanceof LongPollError ? err.retryAfterMs : undefined
      opts.onPollError?.({
        status,
        retryAfterMs,
        message: err instanceof Error ? err.message : String(err),
      })
      // Honour Telegram's explicit 429 cool-down when it exceeds our own
      // exponential backoff (audited fix #13).
      const backoffMs = Math.max(reconnectBackoffMs(backoffBaseMs, attempts), retryAfterMs ?? 0)
      try {
        await delay(backoffMs, opts.signal)
      } catch {
        // Signal fired during backoff — exit cleanly
        return
      }
    }
  }
}
