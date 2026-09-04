/**
 * Headless registration for the Bot delivery runner.
 *
 * The brain is where a Bot most wants to live: it is awake when nobody is at a
 * desktop, and integration ingress (the verified-webhook path most event
 * triggers ride) only exists on the desktop and here.
 *
 * The lease on each delivery is what makes running the same queue in two
 * places safe, so this registration needs no coordination with the desktop's:
 * whichever claims a delivery first runs it, and an expired lease is what lets
 * the other pick up work a crashed Host left behind.
 */

import { startBotDeliveryRunner } from "@/lib/bot/runtime/delivery-runner"

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "bot-delivery-runner",
  hosts: ["brain"],
  start: (ctx) => {
    const runner = startBotDeliveryRunner({
      // Namespaced by host kind AND account, so two brains serving different
      // accounts never contend for one another's leases.
      owner: `brain:${ctx.localAccountId}`,
    })
    return () => runner.stop()
  },
})
