/**
 * WeChat OA webhook transport (TS subscriber).
 *
 * Subscribes to `connectors://webhook/<adapterId>`. The Rust handler verifies
 * the signature, decrypts the safe-mode body, journals it before ACK, and
 * emits `{ xml, ingressId }`. This generator merges pending journal records
 * with live notifications. Stops on abort; the adapter acknowledges each
 * accepted delivery separately.
 */

import { connectorListen as listen } from "@/lib/connectors/events"
import { connectorsWechatOaInboundList } from "@/lib/connectors/tauri/commands"

export interface WechatOaInboundDelivery {
  xml: string
  ingressId?: string
  admitted?: boolean
}

export interface WechatOaWebhookOptions {
  adapterId: string
  signal: AbortSignal
}

export async function* startWechatOaWebhook(
  opts: WechatOaWebhookOptions
): AsyncGenerator<WechatOaInboundDelivery> {
  if (opts.signal.aborted) return
  const eventName = `connectors://webhook/${opts.adapterId}`
  const queue: WechatOaInboundDelivery[] = []
  const queuedIds = new Set<string>()
  let resolve: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let done = false
  let unlisten: (() => void) | undefined
  let recovering = true
  let retryDelay = 250
  let nextReconcileAt = 0
  let notificationVersion = 0
  const notifications = new Map<string, number>()
  let reconcileRequested = true
  const wake = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    resolve?.()
    resolve = null
  }
  const onAbort = () => {
    done = true
    queue.length = 0
    unlisten?.()
    unlisten = undefined
    wake()
  }
  const enqueue = (delivery: WechatOaInboundDelivery) => {
    if (done || opts.signal.aborted || typeof delivery.xml !== "string") return
    if (delivery.ingressId && queuedIds.has(delivery.ingressId)) return
    if (delivery.ingressId) queuedIds.add(delivery.ingressId)
    queue.push(delivery)
    wake()
  }
  opts.signal.addEventListener("abort", onAbort, { once: true })

  try {
    // Subscribe before reading the journal so an arrival between the two
    // cannot be lost. Both surfaces may name the same durable ingress id.
    unlisten = await listen<WechatOaInboundDelivery>(eventName, (event) => {
      if (!event.payload || typeof event.payload.xml !== "string") return
      if (event.payload.ingressId) {
        // The journal owns the body and current record lifetime. A delayed
        // notification can survive ACK or revocation; it is only a wakeup.
        notificationVersion++
        notifications.set(event.payload.ingressId, notificationVersion)
        reconcileRequested = true
        if (!recovering) nextReconcileAt = 0
        wake()
      } else {
        enqueue(event.payload)
      }
    })
    if (opts.signal.aborted) return
    while (!done) {
      if (
        (recovering || reconcileRequested || queue.length === 0) &&
        Date.now() >= nextReconcileAt
      ) {
        try {
          const version = notificationVersion
          const pending = await connectorsWechatOaInboundList(opts.adapterId)
          if (opts.signal.aborted) return
          const legacy = queue.splice(0).filter((delivery) => !delivery.ingressId)
          queuedIds.clear()
          for (const delivery of Array.isArray(pending) ? pending : [])
            enqueue({ xml: delivery.xml, ingressId: delivery.id, admitted: delivery.admitted })
          for (const delivery of legacy) enqueue(delivery)
          recovering = false
          for (const [id, notifiedAt] of notifications) {
            // Notifications already visible in this snapshot need no second
            // read. Only an arrival during the read that is absent may have
            // committed after the native snapshot was taken.
            if (notifiedAt <= version || queuedIds.has(id)) notifications.delete(id)
          }
          reconcileRequested = notifications.size > 0
          retryDelay = 250
          // Reconcile the local authority while idle: enqueue may have
          // committed before its best-effort live notification was lost.
          nextReconcileAt = Date.now() + (reconcileRequested ? 0 : 30_000)
        } catch {
          if (opts.signal.aborted) return
          recovering = true
          nextReconcileAt = Date.now() + retryDelay
          retryDelay = Math.min(retryDelay * 2, 30_000)
        }
      }
      if (queue.length > 0 && !recovering) {
        const delivery = queue.shift()!
        yield delivery
        if (delivery.ingressId) queuedIds.delete(delivery.ingressId)
      } else {
        await new Promise<void>((r) => {
          resolve = r
          timer = setTimeout(wake, Math.max(1, nextReconcileAt - Date.now()))
        })
      }
    }
  } finally {
    done = true
    opts.signal.removeEventListener("abort", onAbort)
    unlisten?.()
    wake()
  }
}
