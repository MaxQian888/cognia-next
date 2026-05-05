/**
 * Lark webhook transport (TS subscriber) — Task 84.
 *
 * Subscribes to the Tauri event channel `connectors://webhook/<adapterId>`.
 * The Rust side handles AES-CBC decrypt + verification-token check (Task 87)
 * and emits the already-verified + decrypted body on this event channel.
 *
 * Yields each LarkEventEnvelope as it arrives; stops cleanly when signal fires.
 */

import { listen } from "@tauri-apps/api/event"
import type { LarkEventEnvelope } from "./parse"

export interface LarkWebhookOptions {
  adapterId: string
  signal: AbortSignal
}

/**
 * Subscribe to the Tauri event channel for this adapter's webhook and yield
 * each LarkEventEnvelope. Cleans up the listener on abort.
 */
export async function* startLarkWebhookTransport(
  opts: LarkWebhookOptions
): AsyncGenerator<LarkEventEnvelope> {
  const eventName = `connectors://webhook/${opts.adapterId}`

  const queue: LarkEventEnvelope[] = []
  let resolve: (() => void) | null = null
  let done = false

  const unlisten = await listen<LarkEventEnvelope>(eventName, (event) => {
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
