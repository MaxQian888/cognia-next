"use client"

/**
 * Mounts the mobile outbound queue runner (`lib/queue/outbound-queue.ts`).
 *
 * The runner drains `mobileOutboundQueue` rows the UI surfaces enqueue
 * (`connector_send`, `workflow_trigger_manual`, `twin_ingest_source`,
 * `connector_approve_draft`, `connector_reject_draft`, plus the existing
 * desktop-write commands) by translating each row to
 * `transport.call(command, payload, { idempotencyKey })`. Without this
 * provider, enqueued rows sit in Dexie forever and the offline banner's
 * pending count climbs without ever decreasing.
 *
 * Platform gate: the runner short-circuits to a no-op outside mobile via
 * `enforceMobile: true`. We additionally only build a runner when
 * `usePlatform() === "mobile"` so the provider doesn't allocate timers /
 * listeners on web or Tauri desktop.
 */

import { useEffect } from "react"

import { transport } from "@/lib/tauri"
import { usePlatform } from "@/hooks/use-platform"
import { createOutboundRunner, type OutboundDispatcher } from "@/lib/queue/outbound-queue"

/** Translate a queued row into a `transport.call` invocation.
 *
 * `opts.idempotencyKey` is recorded on the row for retry-audit purposes,
 * but `CompanionTransport.call` (`lib/tauri/transport-companion.ts:292`)
 * supplies the `Idempotency-Key` HTTP header itself with a fresh UUID per
 * call. Threading the per-row key through to the header is a separate
 * change against the Transport interface — out of scope here. Passing it
 * through the payload would pollute the RPC argument shape, so we drop it. */
const liveDispatcher: OutboundDispatcher = {
  async call(command, payload, _opts) {
    return transport.call(command, payload)
  },
}

export interface MobileOutboundRunnerProviderProps {
  /**
   * Test seam — defaults to `liveDispatcher` which routes through the
   * live transport. Unit tests inject a fake dispatcher to assert the
   * runner is constructed and kicked.
   */
  dispatcher?: OutboundDispatcher
  /**
   * Test seam — overrides `usePlatform()`. Production callers omit this.
   */
  platformOverride?: ReturnType<typeof usePlatform>
}

export function MobileOutboundRunnerProvider({
  dispatcher = liveDispatcher,
  platformOverride,
}: MobileOutboundRunnerProviderProps): null {
  const detected = usePlatform()
  const platform = platformOverride ?? detected

  useEffect(() => {
    if (platform !== "mobile") return

    const runner = createOutboundRunner({ dispatcher })
    // Kick once at mount so any rows that were enqueued while the app was
    // backgrounded drain immediately on resume. Subsequent drains are
    // driven by the runner's internal network-change subscription.
    void runner.kick().catch((err) => {
      console.warn("mobile-outbound-runner: initial kick failed", err)
    })

    return () => {
      runner.stop()
    }
  }, [platform, dispatcher])

  return null
}
