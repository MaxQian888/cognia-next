/**
 * Trigger bridge — converts Tauri-emitted `workflow:trigger` events into
 * orchestrator runs. Mounts once on app boot via `installTriggerBridge`;
 * cleans up via the returned disposer.
 *
 * The Rust side (cron daemon, eventual webhook receiver, connector inbound
 * tap) emits a fully-typed `TriggerEvent`. We resolve the workflow row from
 * Dexie and call `runWorkflow`. Failures are logged and surfaced via the
 * scoped run logger; they don't crash the listener.
 */

import { getWorkflow } from "@/lib/db/workflows"
import type { TriggerEvent, WorkflowTriggeredFrom } from "@/types/workflow/visual"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { runWorkflow } from "./orchestrator"
import { listenTriggerEvents } from "./tauri-bridge"

export type TriggerBridgeDisposer = () => void

/** Subscribe to `workflow:trigger` events. Returns a disposer. */
export async function installTriggerBridge(): Promise<TriggerBridgeDisposer> {
  return listenTriggerEvents(async (raw) => {
    if (!isTriggerEvent(raw)) {
      console.warn("workflow trigger bridge: discarding malformed event", raw)
      return
    }
    try {
      await dispatchTrigger(raw)
    } catch (err) {
      console.error("workflow trigger bridge: dispatch failed", {
        workflowId: raw.workflowId,
        kind: raw.kind,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
}

/**
 * Resolve the workflow row, then invoke the orchestrator. Exported for
 * tests so they can drive the bridge without going through Tauri.
 */
export async function dispatchTrigger(
  event: TriggerEvent,
  opts?: {
    /**
     * Run origin persisted onto `WorkflowRunRow.triggeredBy` (ADR-0060) —
     * lets companion-originated manual triggers record `source: "api"` +
     * the caller `deviceId` instead of defaulting to `"ui"`.
     */
    triggeredBy?: WorkflowTriggeredFrom
  }
): Promise<void> {
  const workflow = await getWorkflow(event.workflowId)
  if (!workflow) {
    console.warn(`workflow trigger bridge: workflow ${event.workflowId} not found; ignoring`)
    return
  }
  // Single canonical fan-in for every trigger path (cron / webhook / connector
  // / chat / plugin all route through here). Resume does NOT call this, so a
  // resumed run correctly does not re-fire the trigger hook.
  getPluginEventHooks().dispatchWorkflowTriggerFired(event.workflowId, event.kind, event.payload)
  await runWorkflow({ workflow, trigger: event, triggeredBy: opts?.triggeredBy })
}

/**
 * Type predicate for the raw event payload. Validates the minimum shape
 * the orchestrator needs before invoking; strict-checking belongs in zod
 * land and isn't worth the bundle weight here.
 */
export function isTriggerEvent(value: unknown): value is TriggerEvent {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    typeof v.workflowId === "string" && typeof v.kind === "string" && typeof v.originAt === "number"
  )
}
