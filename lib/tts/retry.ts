/**
 * Transient-failure retry for cloud TTS synthesis.
 *
 * Providers don't throw — they return `{ success: false, error }` where the
 * `error` is exactly `ERROR_MESSAGES[type]` (see `getTTSError`), so we classify
 * retryability by matching the canonical network/api-error messages. A missing
 * API key or over-length text is permanent and never retried.
 */

import { getTTSError, type TTSResponse } from "@/types/media/tts"

/** Canonical messages for the transient error types worth retrying. */
const RETRYABLE_MESSAGES = new Set<string>([
  getTTSError("network-error").message,
  getTTSError("api-error").message,
])

export function isRetryableTtsFailure(response: TTSResponse): boolean {
  return !response.success && !!response.error && RETRYABLE_MESSAGES.has(response.error)
}

export interface TtsRetryOptions {
  /** Max retry attempts after the first try. Default 2. */
  retries?: number
  /** Backoff before each retry (ms), last value reused if exhausted. Default [250, 750]. */
  backoffMs?: number[]
  /** Injectable sleep (tests pass a no-op). */
  delay?: (ms: number) => Promise<void>
  /** Decide whether a failing response should be retried. */
  isRetryable?: (response: TTSResponse) => boolean
}

const defaultDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Run `fn`, retrying while it returns a retryable failure. Returns the last
 * response (success or final failure) — never throws on its own.
 */
export async function withTtsRetry(
  fn: () => Promise<TTSResponse>,
  options: TtsRetryOptions = {}
): Promise<TTSResponse> {
  const {
    retries = 2,
    backoffMs = [250, 750],
    delay = defaultDelay,
    isRetryable = isRetryableTtsFailure,
  } = options

  let response = await fn()
  let attempt = 0
  while (!response.success && isRetryable(response) && attempt < retries) {
    const wait = backoffMs[attempt] ?? backoffMs[backoffMs.length - 1] ?? 0
    if (wait > 0) await delay(wait)
    response = await fn()
    attempt++
  }
  return response
}
