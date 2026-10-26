/**
 * The plugin contract's share of `lib/ai/agent/team/gates/task-move-guard.ts`, which re-exports these.
 */
/** Why a move was denied — keyed for i18n at the UI layer. */
export type TaskMoveDenial =
  | "blocked-column" // blocked is dependency-derived, read-only
  | "runtime-owned" // claimed/in_progress touched while the run is active
  | "illegal-transition"

/** Store/RPC-level move failure: a guard denial or a missing task. */
export type TaskMoveError = TaskMoveDenial | "task-not-found"
