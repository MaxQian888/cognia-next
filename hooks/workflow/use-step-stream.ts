"use client"

/**
 * Live streaming output for one workflow step.
 *
 * `step_stream` events carry throttled LLM deltas (`{ delta, seq }`, see
 * `lib/workflow/runtime/stream-sink.ts`). Two consumers:
 *   • the Runs UI step inspector — already holds the run's events, so it
 *     reduces them directly via `reduceStepStream`;
 *   • the editor NDV Output tab — watches the workflow's LATEST run through
 *     a gated Dexie live query via `useStepStream`.
 *
 * Chunks are presentation-only: the final full text always lands in
 * `step_completed.output`, so consumers prefer that once the step settles.
 */

import { getDb } from "@/lib/db/index"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"
import { useGatedLiveQuery } from "./use-gated-live-query"

export interface StepStreamState {
  /** Concatenated deltas of the CURRENT attempt ("" when none). */
  text: string
  /** True while the step is running and has produced at least one chunk. */
  isStreaming: boolean
  chunkCount: number
}

export const EMPTY_STEP_STREAM: StepStreamState = { text: "", isStreaming: false, chunkCount: 0 }

/**
 * Pure reducer over a run's events. Retry-aware: only chunks emitted after
 * the LAST `step_started` count (each retry attempt gets a fresh sink whose
 * `seq` restarts at 0 — the monotonic event `ts` is the authoritative order,
 * `seq` only tie-breaks).
 */
export function reduceStepStream(
  events: WorkflowRunEventRow[],
  stepId: string | null
): StepStreamState {
  if (!stepId) return EMPTY_STEP_STREAM
  let lastStartedTs = -1
  let lastTerminalTs = -1
  const chunks: Array<{ ts: number; seq: number; delta: string }> = []

  for (const e of events) {
    if (e.stepId !== stepId) continue
    if (e.type === "step_started") {
      if (e.ts > lastStartedTs) lastStartedTs = e.ts
    } else if (
      e.type === "step_completed" ||
      e.type === "step_failed" ||
      e.type === "step_skipped"
    ) {
      if (e.ts > lastTerminalTs) lastTerminalTs = e.ts
    } else if (e.type === "step_stream") {
      const payload = e.payload as { delta?: unknown; seq?: unknown } | undefined
      chunks.push({
        ts: e.ts,
        seq: typeof payload?.seq === "number" ? payload.seq : 0,
        delta: typeof payload?.delta === "string" ? payload.delta : "",
      })
    }
  }

  const current = chunks
    .filter((c) => c.ts > lastStartedTs)
    .sort((a, b) => a.ts - b.ts || a.seq - b.seq)
  const running = lastStartedTs > lastTerminalTs
  return {
    text: current.map((c) => c.delta).join(""),
    isStreaming: running && current.length > 0,
    chunkCount: current.length,
  }
}

/** Non-hook async accessor over the workflow's latest run (any status). */
export async function getStepStream(
  workflowId: string | undefined,
  stepId: string | null
): Promise<StepStreamState> {
  if (!workflowId || !stepId) return EMPTY_STEP_STREAM
  const db = getDb()
  const rows = await db.workflowRuns
    .where("[workflowId+startedAt]")
    .between([workflowId, 0], [workflowId, Number.POSITIVE_INFINITY])
    .reverse()
    .limit(1)
    .toArray()
  const run = rows[0]
  if (!run) return EMPTY_STEP_STREAM
  const events = await db.workflowRunEvents
    .where("[runId+stepId]")
    .equals([run.id, stepId])
    .toArray()
  return reduceStepStream(events, stepId)
}

/** Gated live hook for the editor NDV (paused while dragging, like the IO tabs). */
export function useStepStream(
  workflowId: string | undefined,
  stepId: string | null,
  enabled: boolean
): StepStreamState {
  return useGatedLiveQuery<StepStreamState>(
    () => getStepStream(workflowId, stepId),
    [workflowId, stepId],
    EMPTY_STEP_STREAM,
    enabled
  )
}
