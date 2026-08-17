/**
 * Driver for the SLA escalation sweep (IM delegation slice 1B). Mirrors
 * `adapters/lark/surface-schedule.ts:startLarkSurfaceSweep`: a
 * `startDailySchedule` handle with a 60 s cadence (an SLA breach should be
 * noticed within a minute) and a 15 s boot delay so it never races the
 * connector runtime install. Installed / disposed by
 * `bootstrap/install-connector-runtime.ts` next to the Lark sweeps — the
 * runtime-owning host (desktop or headless brain) is the only place it runs.
 */

import { loggers } from "@cognia/logging"
import { startDailySchedule, type DailyScheduleHandle } from "@/lib/connectors/daily-schedule"
import { sweepSlaEscalations, type SweepSlaEscalationsDeps } from "./sweep"

export const SLA_ESCALATION_SWEEP_INTERVAL_MS = 60_000
export const SLA_ESCALATION_SWEEP_INITIAL_DELAY_MS = 15_000

export function startSlaEscalationSweep(
  options: {
    intervalMs?: number
    initialDelayMs?: number
    scheduler?: Parameters<typeof startDailySchedule>[0]["scheduler"]
    /** Injected sweep (tests) — defaults to `sweepSlaEscalations`. */
    sweep?: (deps?: SweepSlaEscalationsDeps) => ReturnType<typeof sweepSlaEscalations>
    deps?: SweepSlaEscalationsDeps
  } = {}
): DailyScheduleHandle {
  const sweep = options.sweep ?? sweepSlaEscalations
  return startDailySchedule({
    label: "sla-escalation",
    intervalMs: options.intervalMs ?? SLA_ESCALATION_SWEEP_INTERVAL_MS,
    initialDelayMs: options.initialDelayMs ?? SLA_ESCALATION_SWEEP_INITIAL_DELAY_MS,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    task: async () => {
      const result = await sweep(options.deps)
      if (result.escalated > 0 || result.failures > 0 || result.errors > 0) {
        loggers.network.info("[sla-escalation] sweep", { ...result })
      }
    },
  })
}
