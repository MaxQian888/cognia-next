/**
 * `provider limits` and `provider balance`: the unified limits/balance meters
 * for every configured provider, through the SAME enumerator the `/limits`
 * panel uses (`buildCliLimits`). Nothing is re-fetched or re-parsed here.
 *
 * Every reading is a live upstream call against the account (some providers
 * answer a quota question with a billable probe), so the command requires an
 * explicit `--live`. The verbs differ only in which meters they keep.
 */

import type { LimitsMeter, ProviderLimits } from "@/types/subscription"

import type { ResolvedConfig } from "../config/schema"
import { buildCliLimits, nodeAuthedGet } from "../tui/runtime/limits-data"

export type LimitsVerb = "limits" | "balance"

export interface ProviderLimitsReport {
  verb: LimitsVerb
  fetchedAt: number
  /** Snapshots that kept at least one meter of the verb's kind, or an error. */
  snapshots: ProviderLimits[]
  /** Configured providers that answered with no meter of the verb's kind. */
  silent: string[]
}

export interface ReadLimitsDeps {
  config: ResolvedConfig
  verb: LimitsVerb
  providerId?: string
  now?: () => number
  /** Limits-fetch seam (tests). Defaults to the multi-provider CLI enumerator. */
  loadLimits?: (config: ResolvedConfig, now: number) => Promise<ProviderLimits[]>
}

function defaultLoad(config: ResolvedConfig, now: number): Promise<ProviderLimits[]> {
  return buildCliLimits({ config, now, authedGet: nodeAuthedGet, activeProvider: config.provider })
}

/** `balance` keeps balance meters, `limits` keeps window meters. */
export function metersForVerb(verb: LimitsVerb, meters: readonly LimitsMeter[]): LimitsMeter[] {
  const kind = verb === "balance" ? "balance" : "window"
  return meters.filter((meter) => meter.kind === kind)
}

export async function readProviderLimits(deps: ReadLimitsDeps): Promise<ProviderLimitsReport> {
  const now = (deps.now ?? Date.now)()
  const all = await (deps.loadLimits ?? defaultLoad)(deps.config, now)
  const scoped = deps.providerId
    ? all.filter((snapshot) => snapshot.accountId === deps.providerId)
    : all
  const snapshots: ProviderLimits[] = []
  const silent: string[] = []
  for (const snapshot of scoped) {
    const meters = metersForVerb(deps.verb, snapshot.meters)
    if (meters.length === 0 && !snapshot.error) {
      silent.push(snapshot.accountId ?? snapshot.provider)
      continue
    }
    snapshots.push({ ...snapshot, meters })
  }
  return { verb: deps.verb, fetchedAt: now, snapshots, silent }
}

function amount(value: number | undefined, currency: string | undefined): string {
  if (value === undefined) return "?"
  const unit = currency ? ` ${currency}` : ""
  return `${Number.isInteger(value) ? value : value.toFixed(2)}${unit}`
}

/** One line per meter, both verbs. */
export function formatMeterLine(meter: LimitsMeter, now: number): string {
  const label = (meter.label ?? meter.labelKey?.split(".").pop() ?? meter.id).padEnd(18)
  if (meter.kind === "balance") {
    const currency = meter.currency
    const remaining = amount(meter.remaining, currency)
    const total = meter.total !== undefined ? ` of ${amount(meter.total, currency)}` : ""
    return `${label} ${remaining}${total} remaining  [${meter.status}]`
  }
  const pct = meter.usedPct === null ? "?" : `${meter.usedPct}%`
  const reset =
    typeof meter.resetAt === "number" && meter.resetAt > now
      ? `  resets in ${Math.max(1, Math.round((meter.resetAt - now) / 60_000))} min`
      : ""
  return `${label} ${pct.padStart(4)} used  [${meter.status}]${reset}`
}
