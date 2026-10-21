/**
 * The background start path (ADR-0237): runs queued from failed turns, drained
 * by a scheduler maintenance task.
 *
 * With the start mode at `background`, a failed turn queues a run (trigger
 * `background`) instead of only offering one; nothing runs at that moment. The
 * sweep below launches queued runs on its own clock, bounded three ways so the
 * spend per day has a ceiling a person can read off the settings:
 *
 * - at most `backgroundMaxRunsPerSweep` background runs in flight at once;
 * - no new launch until `backgroundIntervalHours` after the last one started;
 * - every run carries its own budget, as any run does.
 *
 * So a day spends at most (24 / interval) × runs-per-sweep × the run budget.
 * Queued runs older than a week are cancelled: the agent and the failure they
 * came from have moved on. A paired client whose Host owns the conversations
 * skips the sweep; probes run where the agent's tools live.
 *
 * Shaped like the conversation auto-archive sweep
 * (`lib/chat/auto-archive-schedule.ts`): executor registration is separate
 * from the boot install, and the task fires on a fixed hourly tick so a change
 * to the interval setting takes effect without re-creating the task.
 */

import { ensureMaintenanceSchedule } from "@/lib/scheduler/managed-tasks"
import type { AppSettings } from "@cognia/agent-config-types"
import type { HarnessEvolutionRun } from "@/types/harness/evolution"
import type { CreateScheduledTaskInput, ScheduledTaskType } from "@/types/scheduler"
import { isActiveRunStatus, transitionRun } from "../machine"
import { harnessEvolutionSettingsOf, isStartAllowed } from "../settings"

export const HARNESS_EVOLUTION_SWEEP_TASK_TYPE =
  "harness-evolution-sweep" satisfies ScheduledTaskType

export const HARNESS_EVOLUTION_SWEEP_TAG = "system:harness-evolution"

/** The sweep's tick. The launch interval itself is a setting, checked per tick. */
export const HARNESS_EVOLUTION_SWEEP_TICK_MS = 60 * 60_000

/** A queued background run older than this is cancelled instead of launched. */
export const QUEUED_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60_000

// A type alias, not an interface: the run output is stored as a
// `Record<string, unknown>`, which only an alias satisfies structurally.
export type HarnessSweepOutcome = {
  queued: number
  launched: string[]
  expired: string[]
  skipped?: "off" | "host-owned" | "busy" | "interval"
}

export interface HarnessSweepDependencies {
  now(): number
  getSettings(): Promise<AppSettings | null>
  hostOwnsSessions(): boolean
  listRuns(): Promise<HarnessEvolutionRun[]>
  saveRun(next: HarnessEvolutionRun, expectedVersion: number): Promise<HarnessEvolutionRun>
  launch(runId: string): void
}

const isBackground = (r: HarnessEvolutionRun) => r.trigger === "background"

/** One sweep tick. */
export async function runHarnessEvolutionSweep(
  deps: HarnessSweepDependencies
): Promise<HarnessSweepOutcome> {
  const settings = harnessEvolutionSettingsOf(await deps.getSettings())
  if (!isStartAllowed(settings, "background")) {
    return { queued: 0, launched: [], expired: [], skipped: "off" }
  }
  if (deps.hostOwnsSessions()) {
    return { queued: 0, launched: [], expired: [], skipped: "host-owned" }
  }
  const now = deps.now()
  const runs = (await deps.listRuns()).filter(isBackground)
  const expired: string[] = []
  const queued: HarnessEvolutionRun[] = []
  for (const run of runs.filter((r) => r.status === "queued")) {
    if (now - run.createdAt <= QUEUED_RUN_MAX_AGE_MS) {
      queued.push(run)
      continue
    }
    try {
      await deps.saveRun(
        transitionRun(run, "cancelled", { error: "Expired: queued for more than a week." }, now),
        run.version
      )
      expired.push(run.id)
    } catch {
      // Changed meanwhile (launched or cancelled elsewhere): nothing to expire.
    }
  }
  queued.sort((a, b) => a.createdAt - b.createdAt)
  if (queued.length === 0) return { queued: 0, launched: [], expired }

  const active = runs.filter((r) => isActiveRunStatus(r.status)).length
  const room = settings.backgroundMaxRunsPerSweep - active
  if (room <= 0) return { queued: queued.length, launched: [], expired, skipped: "busy" }
  const lastStart = Math.max(0, ...runs.map((r) => r.startedAt ?? 0))
  if (lastStart > 0 && now - lastStart < settings.backgroundIntervalHours * 60 * 60_000) {
    return { queued: queued.length, launched: [], expired, skipped: "interval" }
  }
  const launched = queued.slice(0, room).map((r) => r.id)
  for (const id of launched) deps.launch(id)
  return { queued: queued.length, launched, expired }
}

async function defaultDependencies(): Promise<HarnessSweepDependencies> {
  const [settings, store, mobile, runtime, control] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/lib/db/harness-evolution"),
    import("@/lib/db/mobile-outbound-queue"),
    import("@/lib/runtime/runtime-snapshot-store"),
    import("./run-control"),
  ])
  return {
    now: Date.now,
    getSettings: async () => (await settings.getSettings()) ?? null,
    hostOwnsSessions: () => mobile.hostOwnsSessionState(runtime.getRuntimeSnapshot()),
    // Finished runs too: the interval counts from the last start, whatever became of it.
    listRuns: () => store.listHarnessRuns({ limit: 500 }),
    saveRun: store.saveHarnessRun,
    launch: (runId) => {
      void control.launchHarnessRun(runId).catch((error) => {
        console.warn("Harness background run failed to launch", runId, error)
      })
    },
  }
}

/**
 * Register the scheduler executor for the sweep. Separate from
 * {@link installHarnessEvolutionSweepSchedule}: see
 * `lib/scheduler/executor-owners.ts`.
 */
export async function registerHarnessEvolutionSweepExecutor(): Promise<void> {
  const { registerTaskExecutor } = await import("@/lib/scheduler/task-scheduler")
  registerTaskExecutor(HARNESS_EVOLUTION_SWEEP_TASK_TYPE, async () => {
    try {
      return { success: true, output: await runHarnessEvolutionSweep(await defaultDependencies()) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

/** Register the executor and make sure exactly one sweep task exists. */
export async function installHarnessEvolutionSweepSchedule(): Promise<void> {
  await registerHarnessEvolutionSweepExecutor()
  const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
  const scheduler = getTaskScheduler()
  const task: CreateScheduledTaskInput = {
    name: "Harness evolution sweep",
    type: HARNESS_EVOLUTION_SWEEP_TASK_TYPE,
    trigger: { type: "interval", intervalMs: HARNESS_EVOLUTION_SWEEP_TICK_MS },
    // A missed tick loses nothing: the queue is still there on the next one.
    config: { runMissedOnStartup: false },
    notification: {
      dueReminder: false,
      onStart: false,
      onComplete: false,
      onError: false,
      onProgress: false,
      channels: ["none"],
    },
    createdBy: { kind: "user" },
    tags: [HARNESS_EVOLUTION_SWEEP_TAG],
  }
  await ensureMaintenanceSchedule(scheduler, task)
}
