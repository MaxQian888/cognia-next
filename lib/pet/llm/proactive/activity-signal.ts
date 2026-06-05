// Shared "when was the user last active?" signal. Writers: the main-window
// activity tracker (pointer/key/focus, see hooks/pet/use-activity-tracker.ts)
// and user-sourced pet events. Reader: the proactive idle trigger and the
// overlay Smart-Moving merge. Module-level on purpose — both the hook and the
// bridge glue live in the same (main) window context.

let lastActivityAtMs: number | null = null

/** Record user activity; keeps the newest timestamp (monotonic). */
export function markActivity(at: number): void {
  if (lastActivityAtMs === null || at > lastActivityAtMs) lastActivityAtMs = at
}

export function getLastActivityAtMs(): number | null {
  return lastActivityAtMs
}

/** Test helper — module state must not leak across tests. */
export function __resetActivitySignalForTesting(): void {
  lastActivityAtMs = null
}
