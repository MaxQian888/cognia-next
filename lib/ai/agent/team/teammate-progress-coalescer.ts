/**
 * Teammate-progress reporter — folds a teammate's live `CaptureStreamEvent`
 * stream into throttled `progress_update` team events that drive the workspace
 * activity panel (one in-place row per task, see the agent-team store's
 * `addEvent` replace-in-place rule).
 *
 * Reuses the connector live-activity tracker (`turn-activity-tracker.ts`) for
 * the fold + throttle state machine; this module only adds char accumulation,
 * the team-event shape, and the start/done/failed framing. The only side effect
 * is the injected `emit` sink, so it is fully unit-testable with a spy emit and
 * a fake clock — no Dexie, no timers, no React.
 *
 * Best-effort contract (mirrors the capture loop's own): a throwing `emit`
 * sink is swallowed and never affects the dispatch.
 */
import type { AgentTeamEvent } from "@/types/agent/agent-team"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import type { TeammateChannel } from "./dispatch-teammate"
import {
  createTurnActivityState,
  foldEvent,
  markEmitted,
  shouldEmit,
  summarizeForCard,
  type TurnActivityState,
} from "@/lib/connectors/activity/turn-activity-tracker"

export type TeammateProgressPhase = "start" | "running" | "done" | "failed"

export interface TeammateProgressMeta {
  teamId: string
  teammateId: string
  teammateName: string
  taskId: string
  channel: TeammateChannel
}

export interface TeammateProgressReporter {
  /** Fire the initial `phase:"start"` frame and arm the tracker. */
  start(): void
  /** Fold one capture event; emits a throttled `running` frame when due. */
  onCaptureEvent(event: CaptureStreamEvent): void
  /** Force a terminal `done`/`failed` frame (always emits, then freezes). */
  finalize(phase: "done" | "failed"): void
}

function buildEvent(
  meta: TeammateProgressMeta,
  phase: TeammateProgressPhase,
  state: TurnActivityState,
  charCount: number,
  now: number
): AgentTeamEvent {
  const status = phase === "done" ? "done" : phase === "failed" ? "failed" : "running"
  const snap = summarizeForCard(state, status, now)
  return {
    type: "progress_update",
    teamId: meta.teamId,
    teammateId: meta.teammateId,
    taskId: meta.taskId,
    timestamp: new Date(now),
    data: {
      phase,
      teammateName: meta.teammateName,
      channel: meta.channel,
      toolCount: snap.toolCount,
      ...(snap.currentTool ? { currentTool: snap.currentTool } : {}),
      charCount,
      elapsedMs: snap.elapsedMs,
    },
  }
}

/**
 * Build a reporter for one teammate dispatch. `emit` is the sink (production
 * passes `teamCtx.storeWriter.addEvent`); `now` is injectable for tests.
 */
export function createTeammateProgressReporter(
  meta: TeammateProgressMeta,
  emit: (event: AgentTeamEvent) => void,
  now: () => number = Date.now
): TeammateProgressReporter {
  const state = createTurnActivityState(now())
  let charCount = 0
  let finalized = false

  const safeEmit = (event: AgentTeamEvent): void => {
    try {
      emit(event)
    } catch {
      // A throwing sink must never affect the dispatch.
    }
  }

  return {
    start() {
      if (finalized) return
      safeEmit(buildEvent(meta, "start", state, charCount, now()))
    },
    onCaptureEvent(event) {
      if (finalized) return
      if (event.type === "text-delta") charCount += event.delta.length
      const at = now()
      const { isToolBoundary } = foldEvent(state, event, at)
      if (shouldEmit(state, at, { isToolBoundary })) {
        markEmitted(state, at)
        safeEmit(buildEvent(meta, "running", state, charCount, at))
      }
    },
    finalize(phase) {
      if (finalized) return
      finalized = true
      const at = now()
      markEmitted(state, at)
      safeEmit(buildEvent(meta, phase, state, charCount, at))
    },
  }
}
