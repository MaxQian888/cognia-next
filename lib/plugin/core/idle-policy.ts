/**
 * Idle-suspension policy — the pure decision of whether an enabled plugin has
 * been idle long enough to be host-suspended (resources reclaimed; transparent
 * resume on the next activation event). The manager (`suspendIdlePlugins`)
 * performs the actual suspend; this module only decides.
 *
 * A plugin opts in via `manifest.idleSuspend === true`. We measure idleness
 * from `lastUsedAt` (set on each tool/command invocation). A plugin that has
 * never been used has no idle baseline, so it is never eligible — this avoids
 * suspending a freshly-enabled plugin on the first sweep.
 */

/** Default idle window before an opted-in plugin becomes suspend-eligible. */
export const DEFAULT_IDLE_SUSPEND_MS = 30 * 60 * 1000

export interface SuspendEligibilityInput {
  /** Wall-clock ms of the plugin's most recent invocation, if any. */
  lastUsedAt?: number
  /** Current wall-clock ms. */
  nowMs: number
  /** Idle window override (defaults to {@link DEFAULT_IDLE_SUSPEND_MS}). */
  idleThresholdMs?: number
}

export function isPluginSuspendEligible(input: SuspendEligibilityInput): boolean {
  if (input.lastUsedAt == null) return false
  const threshold = input.idleThresholdMs ?? DEFAULT_IDLE_SUSPEND_MS
  return input.nowMs - input.lastUsedAt >= threshold
}
