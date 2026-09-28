/**
 * Lark webhook transport (TS subscriber) — Task 84.
 *
 * Subscribes to the Tauri event channel `connectors://webhook/<adapterId>`.
 * The Rust side handles AES-CBC decrypt + verification-token check (Task 87)
 * and emits the already-verified + decrypted body on this event channel.
 *
 * GAP: the `url_verification` challenge echo (Lark's endpoint handshake)
 * must be answered by the Rust webhook receiver before events reach this
 * channel — it is handled on the Rust side, not here.
 *
 * Yields each LarkEventEnvelope as it arrives; stops cleanly when signal fires.
 */

import { connectorListen as listen } from "@/lib/connectors/events"
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
  if (opts.signal.aborted) return
  const eventName = `connectors://webhook/${opts.adapterId}`

  const queue: LarkEventEnvelope[] = []
  let resolve: (() => void) | null = null
  let done = false

  const unlisten = await listen<LarkEventEnvelope>(eventName, (event) => {
    if (done) return
    queue.push(event.payload)
    resolve?.()
    resolve = null
  })

  // Clean up on abort
  const onAbort = () => {
    if (done) return
    done = true
    unlisten()
    resolve?.()
    resolve = null
  }
  opts.signal.addEventListener("abort", onAbort, { once: true })
  // Registration can settle after cancellation; an already-aborted signal
  // does not dispatch another event when its listener is attached.
  if (opts.signal.aborted) onAbort()

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
    opts.signal.removeEventListener("abort", onAbort)
    if (!done) {
      unlisten()
    }
  }
}
