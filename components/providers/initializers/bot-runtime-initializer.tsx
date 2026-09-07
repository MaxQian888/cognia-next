"use client"

import { useEffect, useState } from "react"

import { hasCapability } from "@/lib/platform/capabilities"
import { isRemoteHostActive, subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import { acquireExclusiveWebLock } from "@/lib/runtime/exclusive-web-lock"

/** One holder per origin, so two webviews of one app do not both drain. */
export const BOT_RUNTIME_LOCK = "cognia-bot-runtime"

/**
 * Boot the Bot delivery runner on this shell, when this shell is one that
 * should be draining at all.
 *
 * Two gates, and they answer different questions.
 *
 * `always-on` asks whether this process hosts long-lived listeners that outlive
 * the page, which a two-second drain loop is. It is in the desktop and headless
 * baselines only, which are exactly the shells that have event producers and
 * executors.
 *
 * `isRemoteHostActive` asks whether this process is currently a companion. A
 * Tauri desktop driving a remote Cognia still reports `always-on` from its
 * static baseline, so the capability alone would let it drain a queue whose
 * rows were mirrored from the machine it is driving. Those rows are fenced in
 * the queue module too, but a runner that has no work it may legitimately take
 * should not be running. This is the same ordering trap
 * `resolveInboxWriteRoute` documents.
 *
 * The remote check is a SUBSCRIPTION, not a mount-time read: a desktop pairs
 * with a remote host long after boot, and a runner that only checked once would
 * keep going.
 *
 * The runner is lazily imported so a shell that never installs a Bot does not
 * pay for the control plane's module graph at boot.
 */
export function BotRuntimeInitializer() {
  const [remoteActive, setRemoteActive] = useState(isRemoteHostActive)

  useEffect(() => subscribeActiveRemoteTransport((remote) => setRemoteActive(remote !== null)), [])

  useEffect(() => {
    if (!hasCapability("always-on") || remoteActive) return

    const lockAbort = new AbortController()
    let stop: (() => void) | undefined
    let cancelled = false

    void (async () => {
      try {
        const [{ startBotDeliveryRunner }, { getLocalAccountId, markBotRunnerOwned }] =
          await Promise.all([
            import("@/lib/bot/runtime/delivery-runner"),
            import("@/lib/bot/runtime/runner-owner"),
          ])
        const owner = await getLocalAccountId()
        const won = await acquireExclusiveWebLock(BOT_RUNTIME_LOCK, lockAbort.signal)
        if (!won || cancelled) return

        // Rows this host abandoned when it stopped. Reclaimed by owner rather
        // than waiting out a lease nobody is holding: this process IS that
        // owner, and it has just started.
        const { recoverStaleBotDeliveries } = await import("@/lib/db/bot-event-deliveries")
        await recoverStaleBotDeliveries({ owner }).catch(() => 0)
        if (cancelled) return

        const runner = startBotDeliveryRunner({ owner })
        const releaseOwnership = markBotRunnerOwned()
        stop = () => {
          releaseOwnership()
          runner.stop()
        }
      } catch {
        // A shell that cannot start the runner still has to boot. Deliveries
        // stay queued and another Host, or the next boot, drains them.
      }
    })()

    return () => {
      cancelled = true
      lockAbort.abort()
      stop?.()
    }
  }, [remoteActive])

  return null
}
