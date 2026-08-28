"use client"

/**
 * Make a terminally failed Host→target dispatch visible.
 *
 * `hostDispatchQueue` dead-letters explicitly rather than retrying forever
 * (see `failHostDispatch`), and a non-retryable delivery error or an expired
 * deadline terminates the row outright. Until now all three outcomes were only
 * a status on a Dexie row: a live workflow step learned about it through
 * `remote-step-broker`, but a schedule handoff has no local run and a
 * mobile-step whose Host restarted has no waiter left to reject. The work
 * simply stopped, with nothing anywhere saying so.
 *
 * The two authorities that already exist carry it — no second alerting center:
 * the notification center is where the user finds it, and the workflow run
 * event log is where an investigation finds it attached to the run it killed.
 * A handoff has no local run, so it gets the notification only; that is the
 * honest projection, not a gap.
 *
 * Never throws. The dispatch has already failed; failing the audit as well
 * would turn a visible failure into a silent one.
 */

import type { AppendEventInput } from "@/lib/workflow/runtime/event-log"
import type { NotificationInput } from "@/types/notifications"
import type { HostDispatchDomain, HostDispatchJobRow } from "@/types/placement/host-dispatch"

/** How the row reached its terminal state. */
export type HostDispatchTerminalKind =
  /** Attempts exhausted — never retried automatically, needs a human. */
  | "deadletter"
  /** A non-retryable delivery refusal, or the overall deadline expiring. */
  | "failed"

export interface HostDispatchFailure {
  kind: HostDispatchTerminalKind
  /** Structured delivery code (`timeout`, `permission_denied`, `unsupported`, …). */
  code: string
  error: string
  at: number
}

export interface DispatchFailureAuditDeps {
  notify?: (input: NotificationInput) => Promise<unknown>
  appendRunEvent?: (input: AppendEventInput) => Promise<unknown>
}

const DOMAIN_LABEL: Record<HostDispatchDomain, string> = {
  "mobile-step": "Device step",
  "remote-step": "Worker step",
  "schedule-handoff": "Workflow handoff",
  "thread-handoff": "Thread handoff",
}

function describe(job: HostDispatchJobRow, failure: HostDispatchFailure): NotificationInput {
  const what = DOMAIN_LABEL[job.domain]
  const title =
    failure.kind === "deadletter"
      ? `${what} gave up after ${job.attempts} attempts`
      : `${what} could not be delivered`
  const scope = job.label ? ` for ${job.label}` : ""
  return {
    source: "workflow",
    level: "error",
    title,
    body: `${what}${scope} targeting ${job.targetRef} ended as ${failure.code}: ${failure.error}`,
    // One notice per dispatch row, not one per attempt: the row is the unit of
    // work a human would act on, and a retry storm must not bury the center.
    dedupeKey: `host-dispatch.${failure.kind}:${job.id}`,
    ...(job.runId ? { groupKey: `workflow-run:${job.runId}` } : {}),
    ...(job.label ? { href: `/workflows/runs?id=${encodeURIComponent(job.label)}` } : {}),
    sourceRef: { kind: "host-dispatch", id: job.id },
    directed: true,
    meta: {
      dispatchId: job.id,
      domain: job.domain,
      targetRef: job.targetRef,
      kind: job.kind,
      code: failure.code,
      attempts: job.attempts,
      ...(job.runId ? { runId: job.runId } : {}),
      ...(job.stepId ? { stepId: job.stepId } : {}),
    },
  }
}

/**
 * Record one terminal dispatch on both existing surfaces.
 *
 * `deps` exists so a test never touches Dexie or the notification runtime; the
 * defaults are lazy imports so the production path is the same code the test
 * drives, minus the stubs.
 */
export async function recordHostDispatchFailure(
  job: HostDispatchJobRow,
  failure: HostDispatchFailure,
  deps: DispatchFailureAuditDeps = {}
): Promise<void> {
  const notify =
    deps.notify ??
    (async (input: NotificationInput) => {
      const runtime = await import("@/lib/notifications/runtime")
      return runtime.notify(input)
    })

  try {
    await notify(describe(job, failure))
  } catch {
    // Best-effort by contract.
  }

  // A schedule handoff never had a local run: there is no journal to attach to
  // and inventing one would fabricate a run that never executed here.
  if (!job.runId) return

  const appendRunEvent =
    deps.appendRunEvent ??
    (async (input: AppendEventInput) => {
      const log = await import("@/lib/workflow/runtime/event-log")
      return log.appendEvent(input)
    })

  try {
    await appendRunEvent({
      runId: job.runId,
      type: "run_log",
      level: "error",
      ...(job.stepId ? { stepId: job.stepId } : {}),
      payload: {
        kind: "host-dispatch.terminal",
        outcome: failure.kind,
        dispatchId: job.id,
        domain: job.domain,
        targetRef: job.targetRef,
        code: failure.code,
        error: failure.error,
        attempts: job.attempts,
        at: failure.at,
      },
    })
  } catch {
    // Same: the dispatch already failed; failing it twice helps nobody.
  }
}
