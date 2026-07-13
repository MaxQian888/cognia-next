/**
 * ExecutionBroker → scheduler-event bridge.
 *
 * Closes the cross-trigger matrix: when a broker leg settles, emit a unified
 * scheduler event so an event-triggered task or a workflow trigger-bridge can
 * react to "any agent/chat run finished".
 *
 * Deliberately fills ONLY the gaps — it must not duplicate seams that already
 * exist:
 *   - `goal:completed`     already emitted at the goal level   (`lib/goal/completion-linkage.ts`)
 *   - `agent-team:completed` already emitted at the team level (`lib/ai/agent/agent-team.ts`)
 *   - `plan:completed`     already emitted at the plan level    (`lib/agent/plan/runtime.ts`)
 *   - `workflow:*` / scheduled `*:completed` are owned by the workflow / scheduler subsystems
 *
 * Those subsystem events fire once per whole goal/team/plan/run; broker legs are
 * per-TURN, so emitting them here too would double-fire. The remaining gaps are
 * chat turns (no per-turn event existed) and generic agent legs
 * (`subagent` / `connector`), which never emitted `agent:completed`.
 */

import { getExecutionBroker } from "./broker"
import type { ExecutionBroker } from "./broker"
import type { ExecutionLegKind } from "./types"
import { emitSchedulerEvent, type SchedulerEventType } from "@/lib/scheduler/event-integration"
import { createLogger } from "@cognia/logging"

const log = createLogger("execution")

/**
 * Map a settled leg's kind to the scheduler event it should emit — only for the
 * kinds NOT already covered by a subsystem-level seam.
 */
const KIND_TO_EVENT: Partial<Record<ExecutionLegKind, SchedulerEventType>> = {
  chat: "chat:completed",
  subagent: "agent:completed",
  connector: "agent:completed",
}

let unsubscribe: (() => void) | null = null

/**
 * Subscribe the bridge to the broker's lifecycle events. Idempotent — a second
 * call returns the existing teardown. Call once at boot.
 */
export function installExecutionEventBridge(
  broker: ExecutionBroker = getExecutionBroker()
): () => void {
  if (unsubscribe) return unsubscribe
  const off = broker.onEvent((event) => {
    if (event.type !== "leg-completed") return
    const eventType = KIND_TO_EVENT[event.snapshot.kind]
    if (!eventType) return
    void emitSchedulerEvent(
      eventType,
      {
        legId: event.snapshot.id,
        kind: event.snapshot.kind,
        outcome: event.outcome,
        ...(event.snapshot.sessionId ? { sessionId: event.snapshot.sessionId } : {}),
        ...(event.snapshot.projectId ? { projectId: event.snapshot.projectId } : {}),
      },
      "execution-broker"
    ).catch((err) => log.debug("execution event emit failed", { eventType, err }))
  })
  unsubscribe = () => {
    off()
    unsubscribe = null
  }
  return unsubscribe
}

/** True when the bridge is currently installed. */
export function isExecutionEventBridgeInstalled(): boolean {
  return unsubscribe != null
}

/** Tear down the bridge (tests / hot-reload). */
export function __resetExecutionEventBridgeForTesting(): void {
  unsubscribe?.()
  unsubscribe = null
}
