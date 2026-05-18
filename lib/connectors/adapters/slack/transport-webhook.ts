/**
 * Slack Events-API webhook transport (TS subscriber).
 *
 * Subscribes to the Tauri event channel `connectors://webhook/<adapterId>`.
 * The Rust side (`src-tauri/src/connectors/axum_app.rs::verify_slack`) verifies
 * the HMAC-SHA256 (v0) signature + timestamp window, then emits the parsed
 * JSON body on this channel. This generator yields each envelope until
 * `signal` aborts.
 *
 * Mirrors `lark/transport-webhook.ts` — same lifecycle: listen → push to
 * queue → consumer drains → unlisten on abort.
 */

import { listen } from "@tauri-apps/api/event"
import type { SlackEventEnvelope } from "./parse"

export interface SlackWebhookOptions {
  adapterId: string
  signal: AbortSignal
}

export async function* startSlackWebhookTransport(
  opts: SlackWebhookOptions
): AsyncGenerator<SlackEventEnvelope> {
  const eventName = `connectors://webhook/${opts.adapterId}`

  const queue: SlackEventEnvelope[] = []
  let resolve: (() => void) | null = null
  let done = false

  const unlisten = await listen<SlackEventEnvelope>(eventName, (event) => {
    queue.push(event.payload)
    resolve?.()
    resolve = null
  })

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
