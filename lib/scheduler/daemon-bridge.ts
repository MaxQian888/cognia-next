/**
 * Tauri IPC bridge for the in-process scheduler alarm daemon.
 *
 * Mirrors `lib/workflow/runtime/tauri-bridge.ts`: thin wrappers that no-op
 * outside Tauri so the renderer timing path works unchanged in web/mobile. The
 * Rust side lives in `src-tauri/src/scheduler/daemon.rs` + `commands.rs`.
 *
 * Uses the canonical `isTauri()` from `@/lib/platform/detect` (the workflow
 * bridge predates that leaf and re-implements its own; we depend on the shared
 * one instead of adding another copy).
 */

import { isTauri } from "@/lib/platform/detect"

import type { DaemonTaskDueEvent } from "@/types/scheduler"

async function safeInvoke<T>(name: string, payload?: unknown): Promise<T | null> {
  if (!isTauri()) return null
  try {
    const mod = await import("@tauri-apps/api/core").catch(() => null)
    if (!mod) return null
    return (await mod.invoke(name, payload as Record<string, unknown>)) as T
  } catch {
    return null
  }
}

/**
 * Arm (or re-arm) a task to fire at the given epoch-ms instant. The daemon
 * stores a single absolute timestamp per task id; re-arming replaces it.
 */
export async function armTask(taskId: string, fireAtMs: number): Promise<void> {
  await safeInvoke("scheduler_arm_task", { input: { taskId, fireAtMs } })
}

/** Cancel a previously-armed task. Safe to call for unknown ids. */
export async function disarmTask(taskId: string): Promise<void> {
  await safeInvoke("scheduler_disarm_task", { taskId })
}

/**
 * Subscribe to `scheduler:task-due` events emitted by the Rust alarm daemon.
 * Returns an unsubscribe function; a no-op unsubscribe in web mode.
 */
export async function listenTaskDue(
  handler: (event: DaemonTaskDueEvent) => void
): Promise<() => void> {
  if (!isTauri()) return () => undefined
  try {
    const mod = await import("@tauri-apps/api/event")
    const stop = await mod.listen<DaemonTaskDueEvent>("scheduler:task-due", (e) =>
      handler(e.payload)
    )
    return stop
  } catch {
    return () => undefined
  }
}
