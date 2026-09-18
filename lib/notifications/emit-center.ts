// Notification V2 → in-app center bridge.
//
// The durable external-delivery engine (coordinator → governed/webhook intents)
// handles Feishu-bot / webhook targets; the IN-APP notification center is the
// always-on inbox and stays on the existing ADR-0042 `notify()` funnel. This
// module is the one translation: a `DerivedNotificationFact` + its run → a
// `NotificationInput`. The delivery worker injects `emitCenterFromDerivedFact`
// into the coordinator, which calls it best-effort before each commit so a
// crash-retry dedupes on `dedupeKey`/`logicalKey` (the factKey).
//
// It deliberately does NOT re-implement quiet-hours / mute / coalescing —
// `notify()` already resolves those for the center + ephemeral channels.

import { notify } from "./runtime"
import type { ExecutionRunKind } from "@/types/execution/run"
import type { NotificationInput, NotificationSource } from "@/types/notifications"
import type { EmitCenterRecord } from "./delivery/coordinator"
import type { DerivedNotificationFact } from "./delivery/facts"

/**
 * Map the unified execution engine kind onto a `NotificationSource`. There is
 * no dedicated `run` source — the center labels the SUBSYSTEM that owns the
 * run, so a scheduler-fired execution still reads "scheduler".
 */
export function runKindToSource(kind: ExecutionRunKind | undefined): NotificationSource {
  switch (kind) {
    case "workflow":
      return "workflow"
    case "scheduled":
      return "scheduler"
    case "agent-turn":
    case "team":
    case "bot":
    case "delegation":
    case "job":
    case "plan":
    case "goal":
      return "agent-team"
    default:
      return "system"
  }
}

/** The deep-link target for a run fact — the cockpit run detail. */
function runHref(runId: string): string {
  return `/agent-runs?run=${encodeURIComponent(runId)}`
}

/**
 * Emit the in-app center record for one derived run fact. Best-effort — a
 * failure is swallowed by the coordinator (the external intents are the
 * durable guarantee; a missed inbox row is recoverable on replay).
 *
 * `dedupeKey` + `logicalKey` both key on `fact.factKey`: re-deriving the same
 * event (replan, reconciler re-claim) coalesces rather than duplicates, and
 * the record joins back to its delivery intents via the shared logical key.
 */
export const emitCenterFromDerivedFact: EmitCenterRecord = async ({ derived, run }) => {
  const input: NotificationInput = {
    source: runKindToSource(run.kind),
    level: derived.fact.level,
    title: derived.title,
    ...(derived.body ? { body: derived.body } : {}),
    dedupeKey: derived.fact.factKey,
    groupKey: run.id,
    href: runHref(run.id),
    sourceRef: { kind: "run", id: run.id },
    ...(run.projectId ? { projectId: run.projectId } : {}),
    // Approval/interrupt facts are directed (they need a human); progress and
    // terminal pings are ambient activity → dot badge, not the red count.
    directed: derived.fact.purpose === "approval-request",
    // V2 fields — the stable identity + category subscriptions/diagnostics join on.
    logicalKey: derived.fact.factKey,
    category: derived.fact.category,
  }
  await notify(input)
}

/** Convenience wrapper matching the coordinator's `EmitCenterRecord` shape. */
export function makeCenterEmitter(): EmitCenterRecord {
  return emitCenterFromDerivedFact
}

export type { DerivedNotificationFact }
