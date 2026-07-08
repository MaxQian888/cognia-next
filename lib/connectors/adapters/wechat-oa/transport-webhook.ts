/**
 * WeChat OA webhook transport (TS subscriber).
 *
 * Subscribes to `connectors://webhook/<adapterId>`. The Rust handler verifies
 * the signature, decrypts the safe-mode body, and emits `{ xml }` — this
 * generator yields each decrypted message XML string. Stops on abort.
 */

import { connectorListen as listen } from "@/lib/connectors/events"

export interface WechatOaWebhookOptions {
  adapterId: string
  signal: AbortSignal
}

export async function* startWechatOaWebhook(opts: WechatOaWebhookOptions): AsyncGenerator<string> {
  const eventName = `connectors://webhook/${opts.adapterId}`
  const queue: string[] = []
  let resolve: (() => void) | null = null
  let done = false

  const unlisten = await listen<{ xml?: string }>(eventName, (event) => {
    const xml = event.payload?.xml
    if (typeof xml === "string") queue.push(xml)
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
    if (!done) unlisten()
  }
}
