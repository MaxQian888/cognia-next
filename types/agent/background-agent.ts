/**
 * Background-agent status vocabulary.
 *
 * This file used to carry a whole second execution model — a queue, a
 * notification bus, per-step records, a manager state tree, serializers, and a
 * `BACKGROUND_AGENT_STATUS_CONFIG` that shadowed the real one in
 * `lib/agent/constants.ts` through `types/agent/index.ts`'s `export *`. None of
 * it survived the rewrite of `lib/ai/agent/background-agent-manager.ts` into a
 * facade over `BackgroundTaskRegistry`: nothing constructed a `BackgroundAgent`,
 * nothing queued one, nothing read a `BackgroundAgentConfig`. It described a
 * system the app does not have, which is worse than describing nothing —
 * anyone reading it would plan against a queue and a notification model that
 * were never wired.
 *
 * What actually exists lives elsewhere:
 *   - lifecycle + cancellation → `lib/ai/agent/background-agent-manager.ts`
 *   - the durable journal rows  → `lib/background-tasks/registry-core.ts`
 *   - the status → icon/colour table → `lib/agent/constants.ts`
 *
 * Only the status vocabulary is real, because `lib/agent/constants.ts` keys its
 * display table on it.
 */

/**
 * Background agent execution status.
 *
 * Wider than the journal's four-state `BackgroundTaskStatus` on purpose: this
 * is the *display* vocabulary `getBackgroundAgentStatusConfig` resolves, and it
 * covers states a caller can report (`paused`, `waiting`, `timeout`) that the
 * journal folds into `running` / `error`.
 */
export type BackgroundAgentStatus =
  | "idle" // Not started
  | "queued" // Waiting in queue
  | "initializing" // Setting up execution
  | "running" // Currently executing
  | "paused" // Paused by user
  | "waiting" // Waiting for user input or approval
  | "completed" // Successfully completed
  | "failed" // Execution failed
  | "cancelled" // Cancelled by user
  | "timeout" // Execution timed out
