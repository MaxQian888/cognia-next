/**
 * Telegram webhook transport (TS subscriber).
 *
 * Subscribes to the Tauri event channel `connectors://webhook/<adapterId>`.
 * The Rust side verifies the X-Telegram-Bot-Api-Secret-Token header (Task 34)
 * and emits the already-verified body on this event channel.
 *
 * Yields each `TelegramUpdate` as it arrives; stops cleanly when `signal` fires.
 */

import { listen } from "@tauri-apps/api/event"
import type { TelegramUpdate } from "./parse"

export interface WebhookOptions {
  adapterId: string
  signal: AbortSignal
}

/**
 * Subscribe to the Tauri event channel for this adapter's webhook and yield
 * each `TelegramUpdate`. Cleans up the listener on abort.
 */
export async function* startWebhookTransport(opts: WebhookOptions): AsyncGenerator<TelegramUpdate> {
  const eventName = `connectors://webhook/${opts.adapterId}`

  const queue: TelegramUpdate[] = []
  let resolve: (() => void) | null = null
  let done = false

  const unlisten = await listen<TelegramUpdate>(eventName, (event) => {
    queue.push(event.payload)
    resolve?.()
    resolve = null
  })

  // Clean up on abort
  opts.signal.addEventListener("abort", () => {
    done = true
    unlisten()
    resolve?.()
    resolve = null
  })

  try {
    while (!done || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift()!
      } else {
        // Wait for next event or abort
        await new Promise<void>((r) => {
          resolve = r
        })
      }
    }
  } finally {
    if (!done) {
      unlisten()
    }
  }
}
