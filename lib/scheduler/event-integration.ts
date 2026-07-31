/**
 * Scheduler Event Integration
 *
 * Provides integration for event-triggered scheduled tasks.
 * Allows other parts of the application to trigger tasks based on events.
 */

import { getTaskScheduler } from "./task-scheduler"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

/**
 * Event types that can trigger scheduled tasks
 */
export type SchedulerEventType =
  | "session:created"
  | "session:completed"
  | "session:deleted"
  | "sync:started"
  | "sync:completed"
  | "sync:failed"
  | "backup:needed"
  | "backup:completed"
  | "workflow:completed"
  | "agent:completed"
  // A single chat turn finished. Emitted by the ExecutionBroker event bridge
  // (`lib/execution/event-bridge.ts`) when a `chat` leg settles, so an
  // event-triggered task / forward chain can react to "any chat turn finished".
  // No subsystem emitted a per-turn chat event before the broker existed.
  | "chat:completed"
  // Built-in multi-agent terminal events (ADR-0019 / 0022 / 0045). Emitted
  // when a Goal / Agent Team / Plan reaches a terminal status — from either a
  // direct (chat-driven) run or a scheduled run — so an event-triggered task
  // or a forward chain can react ("when goal X finishes → run task Y").
  | "goal:completed"
  | "agent-team:completed"
  | "plan:completed"
  | "custom"
  // Platform Connectors — proactive outbound events (Task 108)
  | "connection:outbound:send"
  | "connection:scheduled:digest"
  | "connection:housekeeping:daily"
  | "job:exited"
  | "monitor:fired"

/**
 * Event data that can be passed to event-triggered tasks
 */
export interface SchedulerEventData {
  eventType: SchedulerEventType
  timestamp: Date
  data?: Record<string, unknown>
}

/**
 * Emit a scheduler event to trigger any tasks listening for this event type
 *
 * @param eventType - The type of event to emit
 * @param data - Optional data to pass to the triggered tasks
 *
 * @example
 * ```ts
 * // Trigger tasks when a session completes
 * await emitSchedulerEvent('session:completed', {
 *   sessionId: 'sess-123',
 *   duration: 3600000,
 * });
 * ```
 */
export async function emitSchedulerEvent(
  eventType: SchedulerEventType,
  data?: Record<string, unknown>,
  eventSource?: string
): Promise<void> {
  try {
    const scheduler = getTaskScheduler()

    log.debug(`Emitting scheduler event: ${eventType}`, { data, eventSource })

    // Trigger any tasks that listen for this event
    await scheduler.triggerEventTask(eventType, eventSource, data)

    log.info(`Scheduler event emitted: ${eventType}`)
  } catch (error) {
    log.error(`Failed to emit scheduler event: ${eventType}`, error)
    throw error
  }
}

/**
 * Create event data object with timestamp
 */
export function createEventData(
  eventType: SchedulerEventType,
  data?: Record<string, unknown>
): SchedulerEventData {
  return {
    eventType,
    timestamp: new Date(),
    data,
  }
}

/**
 * Check if an event type is a valid scheduler event
 */
export function isValidEventType(eventType: string): eventType is SchedulerEventType {
  const validTypes: SchedulerEventType[] = [
    "session:created",
    "session:completed",
    "session:deleted",
    "sync:started",
    "sync:completed",
    "sync:failed",
    "backup:needed",
    "backup:completed",
    "workflow:completed",
    "agent:completed",
    "chat:completed",
    "goal:completed",
    "agent-team:completed",
    "plan:completed",
    "custom",
    "connection:outbound:send",
    "connection:scheduled:digest",
    "connection:housekeeping:daily",
    "job:exited",
    "monitor:fired",
  ]
  return validTypes.includes(eventType as SchedulerEventType)
}
