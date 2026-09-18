// Notification V2 fact derivation — which run events are worth an external
// notification, and what fact they materialize as.
//
// This is the projector's read model: it consumes the Run Journal's ordered
// event delta and turns each notification-worthy event into ONE durable
// `PlannerFact` with a STABLE `logicalKey` (semantic identity — replaying the
// same event must name the same fact, so supersede/dedupe hold). Events that
// carry no operator-facing signal (tool.started, resource.changed…) map to
// `null` — they're in the journal for the run detail view, not for push.
//
// Three fact families, per the design's notification kinds:
//   • run.progress / run.waiting   — runtime-status signals
//   • run.terminal / run.result    — important execution results
//   • run.interrupt / approval.*   — human-action reminders
//
// The fact's `title`/`body` come from the event payload, redacted — never
// the raw step/tool detail, which the disclosure layer may clip further.

import type { RunEvent, ExecutionRun } from "@/types/execution/run"
import type { NotificationCategory, NotificationPurpose } from "@/types/notifications/decision"
import type { NotificationLevel } from "@/types/notifications"
import type { PlannerFact } from "../policy/planner"
import type { RunResultFact, NotificationRenderedPayload } from "@/types/notifications/result"
import { renderDisclosedPayload } from "../result/disclosure"

/** A derived fact + the renderable surface the disclosure layer clips. */
export interface DerivedNotificationFact {
  fact: PlannerFact
  /** The pre-clip render — title + body the disclosure layer reduces. */
  title: string
  body: string
  /** Facts that may carry richer payload — classification before clipping. */
  maxClassification: "public" | "internal" | "confidential" | "restricted"
}

interface EventSpec {
  category: NotificationCategory
  purpose: NotificationPurpose
  level: NotificationLevel
  /** The logical-key slot — stable across a replay of the same event. */
  slot: string
  maxClassification: DerivedNotificationFact["maxClassification"]
}

/** The run-event → notification-fact spec table. `null` ⇒ not notifiable. */
const EVENT_SPECS: Partial<Record<RunEvent["type"], EventSpec>> = {
  "run.started": {
    category: "run.progress",
    purpose: "live-progress",
    level: "info",
    slot: "progress",
    maxClassification: "internal",
  },
  "run.waiting": {
    category: "run.waiting",
    purpose: "live-progress",
    level: "info",
    slot: "waiting",
    maxClassification: "internal",
  },
  "run.paused": {
    category: "run.progress",
    purpose: "live-progress",
    level: "info",
    slot: "progress",
    maxClassification: "internal",
  },
  "run.resumed": {
    category: "run.progress",
    purpose: "live-progress",
    level: "info",
    slot: "progress",
    maxClassification: "internal",
  },
  "run.degraded": {
    category: "run.progress",
    purpose: "live-progress",
    level: "warning",
    slot: "degraded",
    maxClassification: "internal",
  },
  "run.recovery_required": {
    category: "run.interrupt",
    purpose: "incident-alert",
    level: "warning",
    slot: "recovery",
    maxClassification: "confidential",
  },
  "run.completed": {
    category: "run.terminal",
    purpose: "terminal-state",
    level: "info",
    slot: "terminal",
    maxClassification: "internal",
  },
  "run.failed": {
    category: "run.terminal",
    purpose: "terminal-state",
    level: "error",
    slot: "terminal",
    maxClassification: "internal",
  },
  "run.cancelled": {
    category: "run.terminal",
    purpose: "terminal-state",
    level: "warning",
    slot: "terminal",
    maxClassification: "internal",
  },
  "interrupt.requested": {
    category: "approval.request",
    purpose: "approval-request",
    level: "warning",
    slot: "approval",
    maxClassification: "confidential",
  },
  "interrupt.resolved": {
    category: "approval.resolved",
    purpose: "live-progress",
    level: "info",
    slot: "approval-resolved",
    maxClassification: "internal",
  },
  "milestone.created": {
    category: "run.progress",
    purpose: "live-progress",
    level: "info",
    slot: "progress",
    maxClassification: "internal",
  },
  "step.failed": {
    category: "incident",
    purpose: "incident-alert",
    level: "warning",
    slot: "step-failed",
    maxClassification: "confidential",
  },
}

/** The stable logical key for a run-event fact. */
export function runFactLogicalKey(runId: string, slot: string): string {
  return `run:${runId}:${slot}`
}

/**
 * Derive the notification fact for one run event. Returns `null` when the
 * event carries no operator-facing signal — the projector advances the
 * cursor past it without minting a fact.
 *
 * `runId` and the fact's `runId` field are the SAME run — a `run`-bound
 * subscription matches on it. The title/body are read off the event payload
 * (already redacted by the journal); a missing field yields the generic
 * label, never an empty notification.
 */
export function deriveFactFromRunEvent(
  run: ExecutionRun,
  event: RunEvent
): DerivedNotificationFact | null {
  const spec = EVENT_SPECS[event.type]
  if (!spec) return null

  const payload = (event.payload ?? {}) as Record<string, unknown>
  const title = stringField(payload.title) ?? defaultTitle(run, event.type)
  const body = stringField(payload.summary) ?? stringField(payload.detail) ?? ""

  // Interrupt facts key off the interrupt id so each request is its own fact;
  // lifecycle facts share one slot per kind (a re-run.supersede, not re-send).
  const slotId =
    event.type.startsWith("interrupt.") && stringField(payload.interruptId)
      ? `${spec.slot}:${stringField(payload.interruptId)}`
      : spec.slot

  const fact: PlannerFact = {
    factKey: runFactLogicalKey(run.id, slotId),
    category: spec.category,
    purpose: spec.purpose,
    level: spec.level,
    source: "run",
    runId: run.id,
    materialHash: undefined,
    validUntil: undefined,
    maxClassification: spec.maxClassification,
  }
  return { fact, title, body, maxClassification: spec.maxClassification }
}

/**
 * Render a derived fact for ONE target's disclosure profile. The fact's body
 * becomes a single `outcome` evidence line classified at the fact's ceiling;
 * `renderDisclosedPayload` clips it to the profile — a `public` webhook gets
 * the generic privacy title + counts, an `internal` conversation the full
 * line. Returns the frozen `NotificationRenderedPayload` the intent stores.
 */
export function renderFactForTarget(input: {
  derived: DerivedNotificationFact
  profileId: string
  /** Deep-link ref to the run detail — dropped when the profile forbids. */
  detailRef?: string
}): NotificationRenderedPayload {
  const facts: RunResultFact[] = input.derived.body
    ? [
        {
          kind: "outcome",
          text: input.derived.body,
          classification: input.derived.maxClassification,
        },
      ]
    : []
  return renderDisclosedPayload({
    title: input.derived.title,
    genericTitle: "A run notification",
    level: input.derived.fact.level,
    facts,
    profileId: input.profileId,
    ...(input.detailRef ? { detailRef: input.detailRef } : {}),
  })
}

function stringField(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function defaultTitle(run: ExecutionRun, type: RunEvent["type"]): string {
  const name = run.title ?? run.id
  switch (type) {
    case "run.completed":
      return `Run completed: ${name}`
    case "run.failed":
      return `Run failed: ${name}`
    case "run.cancelled":
      return `Run cancelled: ${name}`
    case "run.started":
      return `Run started: ${name}`
    case "interrupt.requested":
      return `Approval needed: ${name}`
    case "run.recovery_required":
      return `Run needs attention: ${name}`
    default:
      return `Run update: ${name}`
  }
}
