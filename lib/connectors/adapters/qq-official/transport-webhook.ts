/**
 * QQ Official Bot webhook transport (TS subscriber).
 *
 * QQ is deprecating the WebSocket gateway for official bots; webhook mode
 * receives the same DISPATCH envelopes over an inbound HTTPS callback
 * instead. The Rust webhook route (`axum_app.rs::qq_official_webhook_handler`)
 * verifies the seeded-Ed25519 signature (`X-Signature-Ed25519` over
 * `timestamp ++ body`), answers the op-13 URL-validation challenge IN-BAND
 * (op 13 never reaches TS), ACKs each push with `{"op":12}`, and emits every
 * verified op-0 envelope on `connectors://webhook/<adapterId>`.
 *
 * This transport yields those envelopes as `QQDispatch` values so `index.ts`
 * can run the exact same `parseQQDispatch → gate → emit` loop as the gateway
 * path — one parser, two transports.
 */

import { connectorListen as listen } from "@/lib/connectors/events"
import type { QQDispatch } from "./parse"

export interface WebhookOptions {
  adapterId: string
  signal: AbortSignal
}

/** Accept only op-0 DISPATCH envelopes with an event type string. */
function isDispatchEnvelope(payload: unknown): payload is QQDispatch {
  if (!payload || typeof payload !== "object") return false
  const env = payload as Record<string, unknown>
  return env.op === 0 && typeof env.t === "string"
}

/**
 * Subscribe to the Tauri event channel for this adapter's webhook and yield
 * each verified `QQDispatch` envelope. Cleans up the listener on abort.
 */
export async function* startWebhookTransport(opts: WebhookOptions): AsyncGenerator<QQDispatch> {
  const eventName = `connectors://webhook/${opts.adapterId}`

  const queue: QQDispatch[] = []
  let resolve: (() => void) | null = null
  let done = false

  const unlisten = await listen<unknown>(eventName, (event) => {
    // Rust only emits verified op-0 envelopes here; filter defensively anyway
    // (the op-13 validation handshake is answered in-band and never forwarded).
    if (!isDispatchEnvelope(event.payload)) return
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
        // Wait for the next event or abort
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
