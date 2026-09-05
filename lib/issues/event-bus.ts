/**
 * In-process fan-out of issue activity (spec 2026-09-06 D9).
 *
 * The trail in `issueEvents` is append-only and read back through Dexie
 * liveQuery, which serves the UI but gives a plugin, a workflow trigger or
 * the notification funnel nothing to subscribe to without polling a table.
 * `lib/db/issue-events.ts` publishes every appended entry here, after the
 * write has committed, so a subscriber only ever sees rows that exist.
 *
 * Same shape as `lib/connectors/credentials-events.ts`: one `EventTarget`,
 * a typed `emit`, and `on*` returning a disposer. A throwing handler is
 * logged and never breaks the write path or its siblings.
 */

import type { IssueEvent, IssueEventKind } from "@/types/issues"

const EVENT_NAME = "issues:event"
const bus: EventTarget = new EventTarget()

export type IssueEventListener = (event: IssueEvent) => void

/** Publish one committed trail entry. Called by the append path only. */
export function emitIssueEvent(event: IssueEvent): void {
  bus.dispatchEvent(new CustomEvent<IssueEvent>(EVENT_NAME, { detail: event }))
}

export interface OnIssueEventOptions {
  /** Only these kinds. Absent means every kind. */
  kinds?: readonly IssueEventKind[]
  /** Only this issue. */
  issueId?: string
}

/** Subscribe. Returns the disposer. */
export function onIssueEvent(
  handler: IssueEventListener,
  options: OnIssueEventOptions = {}
): () => void {
  const kinds = options.kinds ? new Set<IssueEventKind>(options.kinds) : null
  const listener = (raw: Event) => {
    const event = (raw as CustomEvent<IssueEvent>).detail
    if (!event) return
    if (kinds && !kinds.has(event.kind)) return
    if (options.issueId && event.issueId !== options.issueId) return
    try {
      handler(event)
    } catch (error) {
      console.error(
        `[issues/event-bus] handler threw for ${event.kind} on ${event.issueId}:`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  bus.addEventListener(EVENT_NAME, listener)
  return () => bus.removeEventListener(EVENT_NAME, listener)
}
