/**
 * `trigger.issue.event` runner: fans issue trail entries out to subscribed
 * workflows (spec 2026-09-06 D9).
 *
 * Subscribes `lib/issues/event-bus.ts`, which `appendIssueEvent` publishes
 * after each write commits, so a workflow never sees an entry that is not
 * in the trail. Matching runs through `findMatchingWorkflows` like every
 * other renderer-side trigger, with the node's `kinds` and `issueProjectId`
 * params as the filter. Same per-workflow cooldown and in-flight guard as
 * `pet-event-trigger.ts`, so a burst of edits on one issue does not start a
 * run per keystroke.
 *
 * Events written by a workflow's own actions come back through this runner
 * too. The cooldown is the only loop breaker, on purpose: a workflow that
 * comments on the issue that triggered it is a legitimate design, and the
 * orchestrator's own run limits are the ceiling.
 */

import { loggers } from "@cognia/logging"

import type { IssueEvent } from "@/types/issues"

const log = loggers.scheduler

const DEFAULT_COOLDOWN_MS = 2_000

export interface IssueEventTriggerDeps {
  now?: () => number
}

interface RunnerState {
  unsubscribe?: () => void
  lastFired: Map<string, number>
  inflight: Set<string>
  now: () => number
  active: boolean
}

let state: RunnerState | null = null

async function onIssueEvent(event: IssueEvent): Promise<void> {
  const s = state
  if (!s || !s.active) return
  try {
    const [{ dispatchTrigger }, { findMatchingWorkflows }, { getIssue }] = await Promise.all([
      import("./trigger-bridge"),
      import("./trigger-subscriptions"),
      import("@/lib/db/issues"),
    ])
    // One read per event, only after at least one workflow subscribed the
    // kind at all. The container filter needs the row.
    const anyForKind = findMatchingWorkflows("trigger.issue.event", { issueEventKind: event.kind })
    if (anyForKind.length === 0) return
    const issue = await getIssue(event.issueId)
    if (!issue) return
    const matches = findMatchingWorkflows("trigger.issue.event", {
      issueEventKind: event.kind,
      issueProjectId: issue.issueProjectId,
    })
    if (matches.length === 0) return

    const payload: Record<string, unknown> = {
      kind: event.kind,
      at: event.ts,
      eventId: event.id,
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      projectId: issue.projectId,
      issueProjectId: issue.issueProjectId,
      event: event.payload,
    }

    const now = s.now()
    await Promise.all(
      matches.map(async (match) => {
        if (s.inflight.has(match.workflowId)) return
        const cooldown =
          typeof match.params.cooldownMs === "number"
            ? match.params.cooldownMs
            : DEFAULT_COOLDOWN_MS
        const last = s.lastFired.get(match.workflowId) ?? 0
        if (now - last < cooldown) return
        s.lastFired.set(match.workflowId, now)
        s.inflight.add(match.workflowId)
        try {
          await dispatchTrigger({
            workflowId: match.workflowId,
            kind: "trigger.issue.event",
            triggerId: match.nodeId,
            payload,
            originAt: now,
          })
        } catch {
          // Per-match isolation: one bad workflow cannot block the others.
        } finally {
          s.inflight.delete(match.workflowId)
        }
      })
    )
  } catch (error) {
    log.warn?.("issue-event-trigger: dispatch failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Subscribe the issue bus. Idempotent: disposes the previous runner first. */
export function initIssueEventTrigger(deps: IssueEventTriggerDeps = {}): void {
  if (typeof window === "undefined") return
  disposeIssueEventTrigger()
  const s: RunnerState = {
    lastFired: new Map(),
    inflight: new Set(),
    now: deps.now ?? Date.now,
    active: true,
  }
  state = s
  void import("@/lib/issues/event-bus")
    .then(({ onIssueEvent: subscribe }) => {
      if (!state || state !== s || !s.active) return
      s.unsubscribe = subscribe((event) => void onIssueEvent(event))
    })
    .catch((error) => {
      log.warn?.("issue-event-trigger: subscribe failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
}

/** Tear the runner down (unsubscribe from the bus). */
export function disposeIssueEventTrigger(): void {
  const s = state
  if (!s) return
  s.active = false
  state = null
  try {
    s.unsubscribe?.()
  } catch {
    // best-effort
  }
}

/** Test-only: drive one event through the runner without the live bus. */
export async function _injectIssueEventForTest(event: IssueEvent): Promise<void> {
  await onIssueEvent(event)
}
