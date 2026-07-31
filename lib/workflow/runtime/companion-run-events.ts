/**
 * Companion fan-out for workflow run-state transitions (ADR 0061 P2).
 *
 * `persistRunState` (tauri-bridge) is the single funnel every run-status
 * transition already flows through — this module rides it to keep paired
 * devices current without polling:
 *
 *  1. `workflow://run-status` — every transition (including per-step
 *     `lastStepId` advances) as a live WS frame, forwarded by the Rust
 *     companion event bus (`register_default_event_channels`).
 *  2. `sync://invalidate` `{ table: "workflowRuns" }` — on terminal states
 *     only, so the phone's event-driven sync (`installEventDrivenSync`)
 *     re-pulls run history exactly when a run ends. (This channel existed
 *     mobile-side but was never published until now.)
 *  3. `workflow://run-terminal` — push-notification trigger
 *     (`register_push_trigger` fans it to offline devices): failed runs
 *     always; succeeded/cancelled runs only when a paired device triggered
 *     them (`triggeredBy.deviceId`) — the desk user already has the
 *     notification center, and pushing every cron success would be spam.
 *
 * PII posture: emitted payloads carry ids and status only — no workflow
 * names, no error text — because the push channel leaves the device via
 * APNs/FCM. Phones resolve names from their synced Dexie mirror.
 *
 * All emission is best-effort and web-mode no-op (same posture as
 * `needs-input-notifier.ts`); a lost frame degrades to the existing
 * foreground/resume/network sync triggers.
 */

import { isTauri } from "@/lib/platform/detect"
import { getDb } from "@/lib/db/schema"
import type { PersistRunStateInput, WorkflowRunRow } from "@/types/workflow/visual"

export const RUN_STATUS_CHANNEL = "workflow://run-status"
export const RUN_TERMINAL_PUSH_CHANNEL = "workflow://run-terminal"
export const SYNC_INVALIDATE_CHANNEL = "sync://invalidate"

/** Live status frame forwarded to companion WS subscribers. */
export interface WorkflowRunStatusFrame {
  runId: string
  workflowId: string
  status: PersistRunStateInput["status"]
  lastStepId?: string
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"])

/**
 * Emit a Tauri event destined for companion fan-out (event bus / push
 * trigger). Shared by the run-state funnel below and the approval notifier.
 * Throws off-Tauri — callers gate on `isTauri()` and treat delivery as
 * best-effort.
 */
export async function emitCompanionEvent(event: string, payload: unknown): Promise<void> {
  const moduleId = "@tauri-apps/api/event"
  const mod = (await import(/* webpackIgnore: true */ moduleId)) as {
    emit: (event: string, payload: unknown) => Promise<void>
  }
  await mod.emit(event, payload)
}

/** Injectable seams so tests never touch Tauri or a real Dexie. */
export interface CompanionRunEventDeps {
  emit?: (event: string, payload: unknown) => Promise<void>
  getRun?: (runId: string) => Promise<WorkflowRunRow | undefined>
  isTauriFn?: () => boolean
}

async function defaultGetRun(runId: string): Promise<WorkflowRunRow | undefined> {
  return getDb().workflowRuns.get(runId)
}

/**
 * Fan a run-state transition out to companions. Fire-and-forget from
 * `persistRunState` — never throws, never blocks the orchestrator.
 */
export async function notifyCompanionsOfRunState(
  input: PersistRunStateInput,
  deps: CompanionRunEventDeps = {}
): Promise<void> {
  if (!(deps.isTauriFn ?? isTauri)()) return
  const emit = deps.emit ?? emitCompanionEvent
  try {
    const frame: WorkflowRunStatusFrame = {
      runId: input.runId,
      workflowId: input.workflowId,
      status: input.status,
      ...(input.lastStepId ? { lastStepId: input.lastStepId } : {}),
    }
    await emit(RUN_STATUS_CHANNEL, frame)

    if (!TERMINAL_STATUSES.has(input.status)) return
    await emit(SYNC_INVALIDATE_CHANNEL, { table: "workflowRuns" })

    const run = await (deps.getRun ?? defaultGetRun)(input.runId)
    const deviceId = run?.triggeredBy?.deviceId
    const shouldPush = input.status === "failed" || Boolean(deviceId)
    if (shouldPush) {
      await emit(RUN_TERMINAL_PUSH_CHANNEL, {
        runId: input.runId,
        workflowId: input.workflowId,
        status: input.status,
        ...(deviceId ? { deviceId } : {}),
      })
    }
  } catch {
    // Best-effort — see module doc.
  }
}
