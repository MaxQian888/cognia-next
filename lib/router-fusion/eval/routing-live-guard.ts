/**
 * The confirmation rule in front of `cognia eval routing --live` (ADR-0188
 * D20, B6 WP-F2 step 7).
 *
 * The live smoke (WP-E3) established the rule for anything this project calls
 * "live": it may not start on a typo. It needs the user's own settings export,
 * named by `--settings` or the `COGNIA_LIVE_SMOKE_SETTINGS` environment
 * variable, and it runs under the ledger's hard $5 total. A live routing
 * experiment answers to the same rule and reuses the same constants, so there
 * is one ceiling in the codebase rather than two that can drift apart.
 *
 * Two things are worth being precise about, because they are easy to overstate:
 *
 *  - **A routing experiment makes no model call of its own.** It is arithmetic
 *    over runs that already happened and were already paid for. So the cap
 *    bounds a planned spend of zero, and the guard asserts exactly that:
 *    `plannedMicrousd` must be 0 and must fit under the same ceiling the smoke
 *    enforces. The assertion is not decoration — it is what makes it impossible
 *    to add a live probe to this path later without meeting the rule, because
 *    the moment `plannedMicrousd` stops being zero this guard has to be told
 *    about it.
 *  - **A live report may not be built from generated rows.** `--live` requires
 *    a recorded sample set and refuses a simulated one (and any set that mixes
 *    the two), which is the same "a run is either live or simulated, never a
 *    blend" rule the smoke applies to its own report (EVAL-04).
 */

import { LIVE_SMOKE_SETTINGS_ENV } from "@cognia/router-fusion/live/args"
import { formatUsd, LIVE_SMOKE_HARD_CAP_MICROUSD } from "@cognia/router-fusion/live/cap"

export { LIVE_SMOKE_SETTINGS_ENV as ROUTING_LIVE_OPT_IN_ENV }

export type RoutingLiveRefusalCode =
  /** No settings export was named, by flag or by environment variable. */
  | "LIVE_NOT_CONFIRMED"
  /** `--live` was given without a recorded sample set to read. */
  | "SAMPLES_REQUIRED"
  /** The $5 ceiling is missing or the planned spend does not fit under it. */
  | "CAP_NOT_ENFORCED"
  /** The sample set is simulated, or mixes origins; a live report needs recorded rows. */
  | "SIMULATED_SAMPLES"

export interface RoutingLiveGuardInput {
  env: Readonly<Record<string, string | undefined>>
  /** `--settings <file>`, when given. */
  settingsPath?: string | null
  /** `--samples <file>`, when given. */
  samplesPath?: string | null
  /**
   * What the run plans to spend on model calls, in microusd. Zero for every
   * routing experiment there is today; the guard refuses a non-zero plan that
   * does not fit the ceiling, and refuses a non-zero plan outright until this
   * path grows a ledger of its own to book it against.
   */
  plannedMicrousd?: number
}

export type RoutingLiveGuardResult =
  | {
      ok: true
      settingsPath: string
      samplesPath: string
      capMicrousd: number
      capUsd: string
      plannedMicrousd: number
    }
  | { ok: false; code: RoutingLiveRefusalCode; message: string }

/**
 * May a live routing experiment run? Pure: it reads the arguments and the
 * environment it is handed and touches nothing.
 */
export function checkRoutingLiveRun(input: RoutingLiveGuardInput): RoutingLiveGuardResult {
  const cap = LIVE_SMOKE_HARD_CAP_MICROUSD
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    return {
      ok: false,
      code: "CAP_NOT_ENFORCED",
      message: "the shared live hard cap is missing; nothing may run as live",
    }
  }
  const planned = input.plannedMicrousd ?? 0
  if (!Number.isSafeInteger(planned) || planned < 0) {
    return {
      ok: false,
      code: "CAP_NOT_ENFORCED",
      message: `planned spend must be a non-negative whole number of microusd, got ${planned}`,
    }
  }
  if (planned > 0) {
    return {
      ok: false,
      code: "CAP_NOT_ENFORCED",
      message:
        "a routing experiment books no model call, so it cannot plan to spend; a live probe needs its own ledger reservation before it may run",
    }
  }
  if (planned > cap) {
    return {
      ok: false,
      code: "CAP_NOT_ENFORCED",
      message: `planned spend ${formatUsd(planned)} is above the hard cap ${formatUsd(cap)}`,
    }
  }
  const settingsPath =
    input.settingsPath?.trim() || input.env[LIVE_SMOKE_SETTINGS_ENV]?.trim() || ""
  if (!settingsPath) {
    return {
      ok: false,
      code: "LIVE_NOT_CONFIRMED",
      message: `a live routing experiment needs the user's settings export: pass --settings <file> or set ${LIVE_SMOKE_SETTINGS_ENV}`,
    }
  }
  const samplesPath = input.samplesPath?.trim() || ""
  if (!samplesPath) {
    return {
      ok: false,
      code: "SAMPLES_REQUIRED",
      message:
        "a live routing experiment reads samples that really happened: pass --samples <file> (export them from Evaluation → Routing)",
    }
  }
  return {
    ok: true,
    settingsPath,
    samplesPath,
    capMicrousd: cap,
    capUsd: formatUsd(cap),
    plannedMicrousd: planned,
  }
}

/** Refuse a sample set that is not recorded traffic. */
export function checkRoutingLiveSamples(
  label: "live" | "simulated" | null
): { ok: true } | { ok: false; code: RoutingLiveRefusalCode; message: string } {
  if (label === "live") return { ok: true }
  return {
    ok: false,
    code: "SIMULATED_SAMPLES",
    message:
      label === null
        ? "the sample file carries no samples"
        : "the sample file is simulated; a live report is built only from recorded runs (EVAL-04)",
  }
}
