/**
 * Pure decision helper for the global workflow run-progress toaster.
 *
 * Given the previously-observed status of a run and its next status, decide
 * which toast (if any) to surface. Keeping this pure lets the React toaster
 * stay a thin liveQuery → toast shim and makes the transition matrix unit-
 * testable. Mirrors the module-helper style of `lib/claude/over-budget-toast.ts`.
 */

import type { RunStatus } from "@/types/workflow/visual"

export type RunToastKind = "start" | "success" | "error" | "none"

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(["succeeded", "failed", "cancelled"])

function isActive(status: RunStatus): boolean {
  return status === "running" || status === "pending" || status === "waiting" || status === "paused"
}

/**
 * Decide the toast for a run transition.
 *
 * - First observation (`prev` undefined): a still-active run starts a loading
 *   toast; a run already terminal at first sight gets no toast (don't replay
 *   history when the toaster mounts).
 * - Active → succeeded → success; active → failed/cancelled → error.
 * - Everything else (intermediate active transitions, terminal→terminal) → none.
 */
export function decideRunToast(prev: RunStatus | undefined, next: RunStatus): RunToastKind {
  if (prev === undefined) {
    return isActive(next) ? "start" : "none"
  }
  if (prev === next) return "none"
  if (isActive(prev) && next === "succeeded") return "success"
  if (isActive(prev) && (next === "failed" || next === "cancelled")) return "error"
  return "none"
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL.has(status)
}
