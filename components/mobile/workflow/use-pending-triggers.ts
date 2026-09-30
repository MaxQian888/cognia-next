"use client"

/**
 * Workflow ids that currently have an in-flight manual trigger sitting in the
 * mobile outbound queue, with the lane it is in: `queued` (status `pending` —
 * waiting for the Host, possibly backing off between attempts) or `sending`
 * (claimed by the runner and on the wire right now).
 *
 * Why this exists: on mobile, running a workflow only `enqueue`s a
 * `workflow_trigger_manual` job — the actual run row is created on the paired
 * desktop and syncs back later. The workflow list reads `workflowRuns` for its
 * "active" badge, so between the tap and the sync-back the list shows no sign
 * that a run is on its way (and if the desktop is offline, never does). Reading
 * the outbound queue here keeps the list in lock-step with the queue.
 *
 * The two lanes are reported separately because the list used to call both
 * "Sending": a run waiting for a desktop that was switched off read as one
 * being delivered, beside a banner and a queue sheet that both said "queued".
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { getDb } from "@/lib/db/schema"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"

export type PendingTriggerState = "queued" | "sending"

export function usePendingWorkflowTriggers(): ReadonlyMap<string, PendingTriggerState> {
  const rows = useLiveQuery<MobileOutboundJobRow[]>(
    () => getDb().mobileOutboundQueue.where("command").equals("workflow_trigger_manual").toArray(),
    []
  )
  return useMemo(() => {
    const states = new Map<string, PendingTriggerState>()
    for (const row of rows ?? []) {
      if (row.status !== "pending" && row.status !== "sending") continue
      const workflowId = row.payload?.workflowId
      if (typeof workflowId !== "string") continue
      // One workflow, several rows (a legacy duplicate, or a new tap after an
      // earlier run went out): the most advanced lane wins.
      if (row.status === "sending" || !states.has(workflowId)) {
        states.set(workflowId, row.status === "sending" ? "sending" : "queued")
      }
    }
    return states
  }, [rows])
}
