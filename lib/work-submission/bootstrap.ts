/**
 * Where the work-submission runner actually gets started (ADR-0123).
 *
 * A recovery sweep that nothing calls is worse than no sweep at all: the
 * durability guarantee reads as delivered while stranded work quietly piles up.
 * This module is the single place both hosts reach for, so the wiring is
 * reviewable in one file rather than inferred across a provider tree and a
 * headless roster.
 *
 * Recovery dispatch opens the frozen submission and hands it to the same
 * `sendPrompt` boundary as a live Direct Chat turn. No model, workspace, or
 * provider decision is re-resolved during recovery.
 */

import { getAgentExecutionFlags } from "@/lib/ai/agent/execution/feature-flags"
import { interruptSession } from "@/lib/claude/ipc"

import { startWorkOutboxRunner, type Unsubscribe, type WorkOutboxDeps } from "./outbox-runner"
import { createStoredChatDispatch } from "./stored-chat-dispatch"
import { startWorkSubmissionTerminalEvents } from "./terminal-events"

type WorkOutboxBootstrapOverrides = Omit<Partial<WorkOutboxDeps>, "abort" | "dispatch" | "runnerId">

function runnerDeps(
  runnerId: string,
  overrides: WorkOutboxBootstrapOverrides = {}
): WorkOutboxDeps {
  return {
    onError: (error, submissionId) => {
      console.error(`work outbox failed for ${submissionId}`, error)
    },
    ...overrides,
    runnerId,
    dispatch: createStoredChatDispatch(),
    abort: async (submission) => {
      if (submission.sessionId) await interruptSession(submission.sessionId)
    },
  }
}

/**
 * Start the renderer's sweep. Returns an unsubscribe suitable for a React
 * effect cleanup. A no-op while the feature flag is off, so it is safe to mount
 * ahead of the rollout.
 */
export function startRendererWorkOutbox(overrides: WorkOutboxBootstrapOverrides = {}): Unsubscribe {
  if (!getAgentExecutionFlags().durableWorkSubmission) return () => {}
  let stopped = false
  let stopRunner: Unsubscribe = () => {}
  const stopTerminalEvents = startWorkSubmissionTerminalEvents({
    onError: (error) => console.error("work outbox event subscription failed", error),
    onReady: () => {
      if (!stopped) stopRunner = startWorkOutboxRunner(runnerDeps("renderer", overrides))
    },
  })
  return () => {
    stopped = true
    stopRunner()
    stopTerminalEvents()
  }
}

/**
 * Start the headless brain's sweep.
 *
 * The headless host had **no** stranded-run reconciliation at all before this:
 * `recoverStaleDirectChatExecutionRuns` is mounted only in renderer
 * initializers, so a brain that died mid-turn left its runs untouched. Wiring
 * the sweep here is what makes "first-release hosts are Desktop and Headless"
 * true rather than aspirational.
 */
export function startHeadlessWorkOutbox(overrides: WorkOutboxBootstrapOverrides = {}): Unsubscribe {
  if (!getAgentExecutionFlags().durableWorkSubmission) return () => {}
  let stopped = false
  let stopRunner: Unsubscribe = () => {}
  const stopTerminalEvents = startWorkSubmissionTerminalEvents({
    onError: (error) => console.error("work outbox event subscription failed", error),
    onReady: () => {
      if (!stopped) stopRunner = startWorkOutboxRunner(runnerDeps("headless", overrides))
    },
  })
  return () => {
    stopped = true
    stopRunner()
    stopTerminalEvents()
  }
}
