/**
 * Trigger bridge — converts Tauri-emitted `workflow:trigger` events into
 * orchestrator runs. Mounts once on app boot via `installTriggerBridge`;
 * cleans up via the returned disposer.
 *
 * The Rust side (cron daemon, eventual webhook receiver, connector inbound
 * tap) emits a fully-typed `TriggerEvent`. The bridge admits the event through
 * Execution Authority, which pins the active production artifact before the
 * orchestrator starts. Failures never crash the listener.
 */

import type { TriggerEvent, WorkflowTriggeredFrom } from "@/types/workflow/visual"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { executeDeployedWorkflow, WorkflowAdmissionError } from "./execution-authority"
import { deterministicTriggerIdempotencyKey } from "./trigger-idempotency"
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
 * Admit the trigger against the production deployment. Exported for tests so
 * they can drive the bridge without going through Tauri.
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
  const triggerId = resolveTriggerId(event)
  const normalizedEvent =
    triggerId && event.triggerId !== triggerId ? { ...event, triggerId } : event
  // Single canonical fan-in for every trigger path (cron / webhook / connector
  // / chat / plugin all route through here). Resume does NOT call this, so a
  // resumed run correctly does not re-fire the trigger hook.
  // Without a key the ledger lookup in `execution-authority` is skipped
  // outright (`existingInvocation` is only read when one is present), so every
  // trigger minted a fresh invocation and two hosts observing the same cron
  // occurrence both ran it.
  const idempotencyKey = deterministicTriggerIdempotencyKey({
    workflowId: event.workflowId,
    triggerKind: normalizedEvent.kind,
    ...(normalizedEvent.triggerId ? { triggerId: normalizedEvent.triggerId } : {}),
    ...(typeof normalizedEvent.originAt === "number" ? { originAt: normalizedEvent.originAt } : {}),
  })
  try {
    await executeDeployedWorkflow({
      workflowId: event.workflowId,
      entrypoint: "trigger",
      caller: event.kind,
      triggerKind: normalizedEvent.kind,
      triggerId: normalizedEvent.triggerId,
      triggerBinding: normalizedEvent.binding,
      triggerOriginAt: normalizedEvent.originAt,
      payload: normalizedEvent.payload,
      triggeredBy: opts?.triggeredBy,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      onAdmitted: () =>
        getPluginEventHooks().dispatchWorkflowTriggerFired(
          event.workflowId,
          event.kind,
          event.payload
        ),
    })
  } catch (error) {
    if (error instanceof WorkflowAdmissionError && error.code === "deployment-not-found") {
      console.warn(`workflow trigger bridge: workflow ${event.workflowId} not deployed; ignoring`)
      return
    }
    if (error instanceof WorkflowAdmissionError && error.code === "trigger-binding-invalid") {
      console.warn(`workflow trigger bridge: ${error.message}; ignoring`)
      return
    }
    throw error
  }
}

function resolveTriggerId(event: TriggerEvent): string | undefined {
  if (typeof event.triggerId === "string" && event.triggerId.length > 0) return event.triggerId
  if (!event.payload || typeof event.payload !== "object") return undefined
  const legacyTriggerId = (event.payload as Record<string, unknown>).triggerId
  return typeof legacyTriggerId === "string" && legacyTriggerId.length > 0
    ? legacyTriggerId
    : undefined
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
    typeof v.workflowId === "string" &&
    typeof v.kind === "string" &&
    typeof v.originAt === "number" &&
    (v.triggerId === undefined || typeof v.triggerId === "string")
  )
}
