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
import { runSyncDown } from "@/lib/sync/companion-sync"

/**
 * After a manual workflow trigger reaches the desktop, the desktop creates a
 * run row moments later. Pull `workflowRuns` shortly after so the library's
 * "sending" badge flips to the live "active" run (and the run shows up in the
 * runs feed) without waiting for the next foreground/network sync. Best-effort
 * and fire-and-forget; the standard sync triggers + pull-to-refresh remain the
 * source of truth if this early pull races run creation.
 */
const POST_TRIGGER_RUN_SYNC_DELAY_MS = 2500


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
    const result = await transport.call(command, payload)
    if (command === "workflow_trigger_manual") {
      setTimeout(() => {
        void runSyncDown({ only: ["workflowRuns"] }).catch(() => {})
      }, POST_TRIGGER_RUN_SYNC_DELAY_MS)
    }
    return result
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
