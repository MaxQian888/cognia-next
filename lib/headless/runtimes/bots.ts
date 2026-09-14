/**
 * Headless registration for the Bot delivery runner.
 *
 * The brain is where a Bot most wants to live: it is awake when nobody is at a
 * desktop, and integration ingress (the verified-webhook path most event
 * triggers ride) only exists on the desktop and here.
 *
 * Each host drains its OWN queue. `botEventDeliveries` is not in the companion
 * sync protocol as a work queue: rows a companion mirrors are fenced in
 * `lib/db/bot-event-deliveries.ts` and can only be read there. So a brain and a
 * desktop draining "the same" queue is not a thing that happens, and the
 * per-delivery lease is what makes the case that does happen safe, two runners
 * in one process, or a restarted host picking up after itself.
 */

import { recoverStaleBotDeliveries } from "@/lib/db/bot-event-deliveries"
import { startBotDeliveryRunner } from "@/lib/bot/runtime/delivery-runner"
import { markBotRunnerOwned } from "@/lib/bot/runtime/runner-owner"
import { reconcileAllBotSchedules } from "@/lib/bot/schedule/reconcile-timed-triggers"

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "bot-delivery-runner",
  hosts: ["brain"],
  start: (ctx) => {
    // Namespaced by host kind AND account, so two brains serving different
    // accounts never contend for one another's leases.
    const owner = `brain:${ctx.localAccountId}`
    // Rows this brain was executing when it stopped. Owner-scoped, so a peer
    // host's live work is left alone.
    void recoverStaleBotDeliveries({ owner }).catch(() => 0)
    // Armed timed triggers become scheduler rows here, and orphans go.
    void reconcileAllBotSchedules().catch(() => undefined)
    const runner = startBotDeliveryRunner({ owner })
    const releaseOwnership = markBotRunnerOwned()
    return () => {
      releaseOwnership()
      runner.stop()
    }
  },
})
