/**
 * Per-turn throttled cumulative state for the live-activity card (Feature A).
 * PURE logic — no Dexie, no bus, no React, no side effects. The dispatcher
 * The durable execution presentation runner owns an instance per turn and folds each
 * `CaptureStreamEvent` into it, and consults `shouldEmit` to decide when to
 * flush a card update. Keeping the state machine here (out of the dispatcher)
 * makes the throttle/fold semantics unit-testable in isolation.
 *
 * Throttle contract (user spec): emit when
 *   `force` (turn-end) OR `isToolBoundary` (a tool started/finished) OR
 *   `now - lastEmitAt >= THROTTLE_MS` (≥5s heartbeat).
 * A tool boundary always bypasses the heartbeat so the user sees each tool
 * start promptly; the heartbeat guarantees a "still working" tick on long
 * single-tool turns (a 30s bash command).
 */
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import type { DiffHunk } from "./diff-types"
import { extractEditInput, isFileEditTool } from "./diff-producer"

/** Minimum gap between heartbeat (time-based) emits. Tool boundaries bypass this. */
export const THROTTLE_MS = 5000

/** One accumulated file edit for the terminal diff card (Feature B). */
export interface TurnFileEdit {
  toolName: string
  filePath: string
  kind: "edit" | "write" | "multiedit"
  added: number
  removed: number
  hunks: DiffHunk[]
  tooLarge: boolean
}

/** Mutable per-turn cumulative state. The dispatcher holds one instance. */
export interface TurnActivityState {
  turnStartedAt: number
  /** Every tool invocation this turn (edit tools included). */
  toolCount: number
  /** Subset of toolCount that were file edits. */
  editCount: number
  /** Most recent tool-call name (the "current action" label), or null. */
  currentTool: string | null
  /** Timestamp of the last card flush; 0 before the first. */
  lastEmitAt: number
  /** File edits accumulated this turn, in arrival order. */
  edits: TurnFileEdit[]
}

/** Snapshot the surface builder consumes — serializable, frozen view of state. */
export interface TurnActivitySnapshot {
  status: "running" | "done" | "failed"
  elapsedMs: number
  toolCount: number
  editCount: number
  currentTool: string | null
  turnStartedAt: number
  edits: TurnFileEdit[]
}

export interface FoldResult {
  /** True if the event changed visible state (new tool / new edit). */
  stateChanged: boolean
  /** True for tool-call / tool-result — bypasses the heartbeat throttle. */
  isToolBoundary: boolean
}

export function createTurnActivityState(now: number = Date.now()): TurnActivityState {
  return {
    turnStartedAt: now,
    toolCount: 0,
    editCount: 0,
    currentTool: null,
    lastEmitAt: 0,
    edits: [],
  }
}

/**
 * Fold a stream event into the turn state. Mutates `state` in place.
 *
 * Edit extraction happens on the `tool-call` event (input is always present
 * there) so the card reflects "the agent is editing X" immediately, rather
 * than waiting for the tool result. The tool-result event only marks a
 * boundary (a tool completed) — we do not retract an edit if the tool later
 * errors, so a failed edit can over-count by one. That is an acceptable
 * trade-off for a live progress indicator and is documented here.
 */
export function foldEvent(
  state: TurnActivityState,
  event: CaptureStreamEvent,
  _now: number = Date.now()
): FoldResult {
  switch (event.type) {
    case "tool-call": {
      state.toolCount += 1
      state.currentTool = event.toolName
      if (isFileEditTool(event.toolName)) {
        const ex = extractEditInput(event.toolName, event.input)
        if (ex.kind !== null && ex.filePath) {
          state.editCount += 1
          state.edits.push({
            toolName: event.toolName,
            filePath: ex.filePath,
            kind: ex.kind,
            added: ex.stats.added,
            removed: ex.stats.removed,
            hunks: ex.hunks,
            tooLarge: ex.tooLarge,
          })
        }
      }
      return { stateChanged: true, isToolBoundary: true }
    }
    case "tool-result": {
      // A tool completed — a natural emit boundary. No new counts unless the
      // edit was extracted on its tool-call (already counted). Update the
      // current-tool label to reflect "just finished" only when we have no
      // better signal (currentTool stays as the last invoked tool).
      return { stateChanged: false, isToolBoundary: true }
    }
    case "text-delta":
    case "thinking-delta":
    case "usage":
    case "compact":
      // Surfaced in the final reply / footer, not the activity card.
      return { stateChanged: false, isToolBoundary: false }
    default:
      return { stateChanged: false, isToolBoundary: false }
  }
}

/** The throttle gate. True when a card flush should fire for this event. */
export function shouldEmit(
  state: TurnActivityState,
  now: number,
  opts: { isToolBoundary: boolean; force?: boolean }
): boolean {
  if (opts.force) return true
  if (opts.isToolBoundary) return true
  return now - state.lastEmitAt >= THROTTLE_MS
}

/** Record that a flush just fired. */
export function markEmitted(state: TurnActivityState, now: number = Date.now()): void {
  state.lastEmitAt = now
}

/** Build a serializable snapshot for the surface builder. */
export function summarizeForCard(
  state: TurnActivityState,
  status: "running" | "done" | "failed",
  now: number = Date.now()
): TurnActivitySnapshot {
  return {
    status,
    elapsedMs: Math.max(0, now - state.turnStartedAt),
    toolCount: state.toolCount,
    editCount: state.editCount,
    currentTool: state.currentTool,
    turnStartedAt: state.turnStartedAt,
    edits: state.edits.map((e) => ({
      ...e,
      hunks: e.hunks.map((h) => ({ ...h, lines: [...h.lines] })),
    })),
  }
}
