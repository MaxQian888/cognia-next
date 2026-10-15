"use client"

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"

import {
  onSandboxPlacementReport,
  sandboxDeliveryRecords,
  readTaskDeliveryRecord,
  recordTaskDelivery,
  sandboxPlacementReport,
  subscribeSandboxPlacements,
  type SandboxPlacementReport,
} from "@/lib/sandbox/placement-report"
import { onRunEnvironmentOutcome, runEnvironmentOutcome } from "@/lib/sandbox/run-environment"
import type { SandboxPlacementOutcome } from "@/lib/sandbox/environment-placement"
import { environmentDeliveryList } from "@/lib/project-environment/environment-client"
import { transport, onTransportChange } from "@/lib/tauri/transport-instance"
import { collectPages } from "@/lib/tauri/companion-paging"
import {
  getActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import type { TaskDeliveryRecord } from "@/types/sandbox/environment-spec"
import { parseInvokeError } from "@/lib/tauri/command-error"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

// The initial local transport remains the default cache scope; replacement
// companion transports must never reuse its agent ids or pending snapshots.
const initialTransport = transport
const placementHost = () =>
  getActiveRemoteTransport() ?? (transport === initialTransport ? undefined : transport)
function subscribePlacementHost(notify: () => void): () => void {
  const remote = subscribeActiveRemoteTransport(notify)
  const process = onTransportChange(notify)
  return () => {
    remote()
    process()
  }
}

/**
 * What one agent's run asked for and what it actually got (ADR-0182).
 *
 * Two halves, deliberately not merged:
 *
 * - `requested` is the brain's own verdict — `off`, `placed`, `fallback` or
 *   `refused` — and it exists for every run, including one the Host never saw.
 * - `report` is the Host's answer, and it exists only once a placed spawn has
 *   started. It is the only honest source for the tier, the user and the
 *   digests, because all three can differ from the request: a driver attests
 *   the tier it has, `remoteUser` is remapped, and an image that declares no
 *   user gets the tier default.
 *
 * A surface that rendered `requested` as if it were the outcome would claim a
 * gVisor sandbox for a run the daemon gave a plain container.
 */
export interface SandboxPlacementState {
  requested: SandboxPlacementOutcome | undefined
  report: SandboxPlacementReport | undefined
  deliveries: readonly TaskDeliveryRecord[]
  deliveryStatus: "loading" | "ready" | "unavailable" | "failed"
}

/** Subscribe before hydrating; revisions reconcile events racing the snapshot. */
function useSandboxPlacementChannel(
  agentId: string | undefined,
  host?: object
): SandboxPlacementState["deliveryStatus"] {
  const [load, setLoad] = useState<{
    agentId?: string
    host?: object
    status: SandboxPlacementState["deliveryStatus"]
  }>({ status: "loading" })
  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    let inFlight = false
    const isCurrent = () => !cancelled && placementHost() === host
    const refresh = async () => {
      if (!agentId || !isCurrent() || inFlight) return
      inFlight = true
      try {
        const records = await collectPages(
          (pageToken) => {
            if (!isCurrent()) throw new Error("Delivery Host changed")
            return environmentDeliveryList({
              agentId,
              pageSize: 200,
              ...(pageToken ? { pageToken } : {}),
            })
          },
          { requireComplete: true }
        )
        if (!isCurrent()) return
        for (const value of records) {
          const record = readTaskDeliveryRecord(value)
          if (record?.agentId === agentId) {
            recordTaskDelivery(record, host)
          }
        }
        setLoad({ agentId, host, status: "ready" })
      } catch (error) {
        if (!isCurrent()) return
        const code = parseInvokeError(error).code
        const unavailable = [
          "sandbox_pool_disabled",
          "unknown_command",
          "not_supported",
          "command_not_found",
          "no_host_transport",
        ].includes(code)
        setLoad({ agentId, host, status: unavailable ? "unavailable" : "failed" })
      } finally {
        inFlight = false
      }
    }
    void subscribeSandboxPlacements(async (channel, handler) => {
      const unlisten = await onTauriEvent<unknown>(channel, (payload) => {
        if (isCurrent()) handler(payload)
      })
      return () => safeUnlisten(unlisten)
    }, host)
      .then((unsubscribe) => {
        if (cancelled) unsubscribe()
        else stop = unsubscribe
      })
      .catch(() => undefined)
      .finally(() => {
        void refresh()
      })
    // Cleanup retries may happen while disconnected. Refresh on reconnection,
    // focus and periodically so their persisted state never depends on an event.
    const timer = setInterval(() => {
      void refresh()
    }, 15_000)
    const onRefresh = () => {
      void refresh()
    }
    window.addEventListener("online", onRefresh)
    window.addEventListener("focus", onRefresh)
    return () => {
      cancelled = true
      stop?.()
      clearInterval(timer)
      window.removeEventListener("online", onRefresh)
      window.removeEventListener("focus", onRefresh)
    }
  }, [agentId, host])
  return load.agentId === agentId && load.host === host ? load.status : "loading"
}

/**
 * One agent's placement, request and answer, kept current.
 *
 * `agentId` may be `undefined` while a surface has no run selected; the hook
 * still subscribes, so the first report for the agent it is later given is not
 * missed.
 */
export function useSandboxPlacement(agentId: string | undefined): SandboxPlacementState {
  const host = useSyncExternalStore(subscribePlacementHost, placementHost, () => undefined)
  const deliveryStatus = useSandboxPlacementChannel(agentId, host)

  // Both halves live in module-scoped stores that hand back the recorded
  // object itself, so each read is a stable snapshot and a render only
  // follows a record for this agent. Reading them at render time also covers
  // an id change: whatever already arrived for the new agent is shown at once.
  const subscribeRequested = useCallback(
    (notify: () => void) =>
      onRunEnvironmentOutcome((id) => {
        if (id === agentId) notify()
      }),
    [agentId]
  )
  const requested = useSyncExternalStore(
    subscribeRequested,
    () => (agentId ? runEnvironmentOutcome(agentId) : undefined),
    () => undefined
  )

  const subscribeReport = useCallback(
    (notify: () => void) =>
      onSandboxPlacementReport((report, reportHost) => {
        if (report.agentId === agentId && reportHost === host) notify()
      }),
    [agentId, host]
  )
  const report = useSyncExternalStore(
    subscribeReport,
    () => (agentId ? sandboxPlacementReport(agentId, host) : undefined),
    () => undefined
  )

  const deliveries = useSyncExternalStore(
    subscribeReport,
    () => sandboxDeliveryRecords(agentId ?? "", host),
    () => sandboxDeliveryRecords("")
  )
  return useMemo(
    () => ({ requested, report, deliveries, deliveryStatus }),
    [requested, report, deliveries, deliveryStatus]
  )
}
