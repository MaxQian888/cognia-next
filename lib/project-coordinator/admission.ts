import type { ResolvedCoordinatorConfig } from "./config"

/**
 * Pure admission rules for project threads (ADR-0204). Hard limits (paused,
 * daily cap) refuse everyone; soft limits (propose-first, concurrency) only
 * stage what the coordinator starts on its own — a person clicking Start has
 * already made the call the soft limits exist to ask for.
 */

export type ThreadRefusal = "disabled" | "paused" | "daily-cap"
export type ThreadStaging = "propose-first" | "over-concurrency"

export type ThreadAdmission =
  | { kind: "start" }
  | { kind: "stage"; reason: ThreadStaging }
  | { kind: "refuse"; reason: ThreadRefusal }

export interface ThreadCreationInput {
  config: ResolvedCoordinatorConfig
  /** Threads this workspace created since local midnight. */
  createdToday: number
}

/** May a new thread be created at all? */
export function admitThreadCreation(
  input: ThreadCreationInput
): { kind: "allow" } | { kind: "refuse"; reason: ThreadRefusal } {
  if (!input.config.enabled) return { kind: "refuse", reason: "disabled" }
  if (input.config.paused) return { kind: "refuse", reason: "paused" }
  if (input.createdToday >= input.config.preferences.dailyThreadCap) {
    return { kind: "refuse", reason: "daily-cap" }
  }
  return { kind: "allow" }
}

export interface ThreadStartInput {
  config: ResolvedCoordinatorConfig
  /** Threads of this workspace with a turn in flight right now. */
  running: number
  requestedBy: "coordinator" | "user"
}

/** Start a created thread now, stage it for the user, or refuse. */
export function admitThreadStart(input: ThreadStartInput): ThreadAdmission {
  if (!input.config.enabled) return { kind: "refuse", reason: "disabled" }
  if (input.config.paused) return { kind: "refuse", reason: "paused" }
  if (input.requestedBy === "user") return { kind: "start" }
  const { proposeBeforeStart, maxConcurrentThreads } = input.config.preferences
  if (proposeBeforeStart) return { kind: "stage", reason: "propose-first" }
  if (maxConcurrentThreads !== undefined && input.running >= maxConcurrentThreads) {
    return { kind: "stage", reason: "over-concurrency" }
  }
  return { kind: "start" }
}

/** Local midnight of the day containing `now` — the daily cap's window start. */
export function startOfLocalDay(now: number): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}
