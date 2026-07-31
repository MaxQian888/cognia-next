"use client"

/**
 * Set of workflow ids that currently have an in-flight manual trigger sitting
 * in the mobile outbound queue (status `pending` or `sending`).
 *
 * Why this exists: on mobile, running a workflow only `enqueue`s a
 * `workflow_trigger_manual` job — the actual run row is created on the paired
 * desktop and syncs back later. The workflow list reads `workflowRuns` for its
 * "active" badge, so between the tap and the sync-back the list shows no sign
 * that a run is on its way (and if the desktop is offline, never does). Reading
 * the outbound queue here keeps the list in lock-step with the "sending" state.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { getDb } from "@/lib/db/schema"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"

export function usePendingWorkflowTriggers(): ReadonlySet<string> {
  const rows = useLiveQuery<MobileOutboundJobRow[]>(
    () => getDb().mobileOutboundQueue.where("command").equals("workflow_trigger_manual").toArray(),
    []
  )
  return useMemo(() => {
    const ids = new Set<string>()
    for (const row of rows ?? []) {
      if (row.status !== "pending" && row.status !== "sending") continue
      const workflowId = row.payload?.workflowId
      if (typeof workflowId === "string") ids.add(workflowId)
    }
    return ids
  }, [rows])
}
