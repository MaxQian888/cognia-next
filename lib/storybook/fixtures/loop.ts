// Storybook-only fixtures for the `/loop` subsystem (`components/loop/**`).
// Mirrors the inline fixture in loop-status-pill.stories.tsx, factored out so
// the detail-sheet / tab stories share one source. Dependency-free (types only).
import type { Loop, LoopEvent } from "@/types/loop"

/** Fixed clock so timeline buckets render deterministically. */
export const LOOP_NOW = 1_700_000_000_000

export function makeLoop(over: Partial<Loop> = {}): Loop {
  return {
    id: "loop_1",
    sessionId: "ses_a",
    mode: "self_paced",
    rawPrompt: "Summarize new commits and flag risky diffs",
    safePrompt: "Summarize new commits and flag risky diffs",
    redactionMapEnc: "",
    isSlashCommand: false,
    status: "active",
    iterations: 6,
    tokensUsed: 48_200,
    generationId: "gen-1",
    config: {
      maxIterations: 100,
      maxTokens: 1_000_000,
      minDelayMs: 60_000,
      maxDelayMs: 3_600_000,
      maxParseFailures: 3,
    },
    parseFailureCount: 0,
    createdAt: LOOP_NOW - 40 * 60_000,
    updatedAt: LOOP_NOW,
    ...over,
  }
}

function makeLoopEvent(
  over: Partial<LoopEvent> & Pick<LoopEvent, "loopId" | "payload">
): LoopEvent {
  return {
    id: `lev_${Math.random().toString(36).slice(2)}`,
    kind: over.payload.kind,
    ts: LOOP_NOW,
    ...over,
  }
}

/** A reverse-chrono-ready event log for one loop (Activity tab populated state). */
export function makeLoopEventLog(loopId: string): LoopEvent[] {
  return [
    makeLoopEvent({
      loopId,
      ts: LOOP_NOW - 38 * 60_000,
      payload: {
        kind: "loop_created",
        mode: "self_paced",
        safePrompt: "Summarize new commits and flag risky diffs",
        config: {
          maxIterations: 100,
          maxTokens: 1_000_000,
          minDelayMs: 60_000,
          maxDelayMs: 3_600_000,
          maxParseFailures: 3,
        },
      },
    }),
    makeLoopEvent({
      loopId,
      ts: LOOP_NOW - 36 * 60_000,
      payload: { kind: "iteration_started", iteration: 1 },
    }),
    makeLoopEvent({
      loopId,
      ts: LOOP_NOW - 35 * 60_000,
      payload: { kind: "iteration_completed", iteration: 1, tokensDelta: 6200 },
    }),
    makeLoopEvent({
      loopId,
      ts: LOOP_NOW - 34 * 60_000,
      payload: { kind: "delay_decided", delayMs: 300_000, reason: "build still running" },
    }),
    makeLoopEvent({
      loopId,
      ts: LOOP_NOW - 5 * 60_000,
      payload: { kind: "user_paused" },
    }),
  ]
}
