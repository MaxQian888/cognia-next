"use client"

import { useEffect } from "react"

/**
 * Boot the Bot delivery runner on this shell.
 *
 * Deliberately unconditional across shells. The lease on each delivery is what
 * makes running the same queue in several places safe, so a desktop and a
 * brain both draining it is the design rather than a race: whichever claims a
 * delivery first runs it, and an expired lease is what lets one pick up work
 * the other's crash left behind.
 *
 * The runner is lazily imported so a shell that never installs a Bot does not
 * pay for the control plane's module graph at boot.
 */
export function BotRuntimeInitializer() {
  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false

    void (async () => {
      try {
        const [{ startBotDeliveryRunner }, { getLocalAccountId }] = await Promise.all([
          import("@/lib/bot/runtime/delivery-runner"),
          import("@/lib/bot/runtime/runner-owner"),
        ])
        if (cancelled) return
        const runner = startBotDeliveryRunner({ owner: await getLocalAccountId() })
        stop = () => runner.stop()
      } catch {
        // A shell that cannot start the runner still has to boot. Deliveries
        // stay queued and another Host, or the next boot, drains them.
      }
    })()

    return () => {
      cancelled = true
      stop?.()
    }
  }, [])

  return null
}
