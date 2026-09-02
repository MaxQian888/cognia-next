// Pure half of the tray's subscription-quota surface (ADR-0025 unified
// limits): projection from `ProviderLimits[]` (what `useAllConfiguredLimits`
// returns) into the compact `TrayUsageAccount` shape, plus the formatters
// that render one meter the same way in the menu row, the tooltip suffix,
// the icon badge and the macOS title. No React / no I/O — the menu builder
// and its node-env tests import this without dragging the subscription
// stack along. The reactive half lives in `lib/tray/usage.ts`.

import {
  formatTaskbarUsage,
  glanceSeverity,
  type GlanceSeverity,
} from "@/lib/usage/usage-glance-format"
import type { UsageGlanceMetric } from "@/lib/usage/usage-glance"
import type { LimitsMeter, ProviderLimits } from "@/types/subscription"
import type { TrayUsageAccount, TrayUsageMeterSummary, TrayUsageSnapshot } from "./types"

/** Stable selection key for one limits snapshot (account or custom source). */
export function trayUsageAccountKey(
  snap: Pick<ProviderLimits, "provider" | "accountId" | "accountLabel">
): string {
  return `${snap.provider}:${snap.accountId ?? snap.accountLabel ?? ""}`
}

function summarizeMeter(meter: LimitsMeter): TrayUsageMeterSummary {
  return {
    id: meter.id,
    labelKey: meter.labelKey,
    label: meter.label,
    kind: meter.kind,
    usedPct: meter.usedPct,
    status: meter.status,
    resetAt: meter.resetAt,
    remaining: meter.remaining,
    unit: meter.unit,
    currency: meter.currency,
  }
}

/**
 * The meter compact surfaces show for an account: highest `usedPct` wins;
 * when no meter carries a percent (credit-only providers), fall back to the
 * first meter reporting a `remaining` balance.
 */
export function worstMeterOf(meters: TrayUsageMeterSummary[]): TrayUsageMeterSummary | null {
  let worst: TrayUsageMeterSummary | null = null
  let worstPct = -1
  for (const meter of meters) {
    if (meter.usedPct == null) continue
    if (meter.usedPct > worstPct) {
      worstPct = meter.usedPct
      worst = meter
    }
  }
  if (worst) return worst
  return meters.find((m) => typeof m.remaining === "number") ?? null
}

/** Project the aggregate limits result into per-account tray summaries. */
export function summarizeLimits(snapshots: ProviderLimits[]): TrayUsageAccount[] {
  return snapshots.map((snap) => {
    const meters = snap.meters.map(summarizeMeter)
    return {
      key: trayUsageAccountKey(snap),
      provider: snap.provider,
      accountLabel: snap.accountLabel,
      worst: worstMeterOf(meters),
      meters,
      error: snap.error,
    }
  })
}

/**
 * Resolve which account compact surfaces (badge / title / tooltip) display:
 * the pinned key when it still exists, else the account whose worst meter is
 * most utilized, else the first account that has anything to show.
 */
export function selectDisplayAccount(
  accounts: TrayUsageAccount[],
  selectedKey: string | null
): TrayUsageAccount | null {
  if (selectedKey) {
    const pinned = accounts.find((a) => a.key === selectedKey)
    if (pinned) return pinned
  }
  let best: TrayUsageAccount | null = null
  let bestPct = -1
  for (const account of accounts) {
    const pct = account.worst?.usedPct
    if (pct == null) continue
    if (pct > bestPct) {
      bestPct = pct
      best = account
    }
  }
  return best ?? accounts.find((a) => a.worst !== null) ?? null
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  CNY: "¥",
  RMB: "¥",
  EUR: "€",
  GBP: "£",
}

function formatRemaining(meter: TrayUsageMeterSummary): string | null {
  if (typeof meter.remaining !== "number") return null
  const rounded = Math.round(meter.remaining * 100) / 100
  const symbol = CURRENCY_SYMBOLS[(meter.currency ?? meter.unit ?? "").toUpperCase()]
  if (symbol) return `${symbol}${rounded}`
  return meter.unit ? `${rounded} ${meter.unit}` : String(rounded)
}

/**
 * The shortest useful readout for one meter: "42%" for window meters (and
 * balances that expose a percent), else the remaining balance ("¥88.5"),
 * else `null` when the meter carries nothing displayable.
 */
export function formatMeterShort(meter: TrayUsageMeterSummary): string | null {
  if (meter.usedPct != null) return `${Math.max(0, Math.round(meter.usedPct))}%`
  return formatRemaining(meter)
}

/** Compact "resets in" delta ("45m", "1h05m", "3d") or `null` when unknown/past. */
export function formatResetDelta(resetAt: number | null | undefined, now: number): string | null {
  if (resetAt == null) return null
  const deltaMs = resetAt - now
  if (deltaMs <= 0) return null
  const mins = Math.ceil(deltaMs / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours >= 48) return `${Math.round(hours / 24)}d`
  return `${hours}h${String(mins % 60).padStart(2, "0")}m`
}

/**
 * One-line literal label for an account's menu row / tooltip fragment, e.g.
 * "Claude Pro · 42% · 1h05m" or "OpenRouter · $8.5". Literals pass through
 * the resilient tray translator unchanged.
 */
export function formatAccountLine(account: TrayUsageAccount, now: number): string {
  const label = account.accountLabel?.trim() || account.provider
  if (!account.worst) {
    // Snapshot exists but nothing displayable — surface the error marker so
    // the row explains why no number shows.
    return account.error ? `${label} · ⚠` : label
  }
  const parts = [label]
  const short = formatMeterShort(account.worst)
  if (short) parts.push(short)
  const reset = formatResetDelta(account.worst.resetAt, now)
  if (reset) parts.push(reset)
  return parts.join(" · ")
}

/**
 * Severity of a glance projection, mapped onto the meter vocabulary the tray's
 * badge colors already speak. Keeping one vocabulary is what stops the icon
 * from meaning "95% of plan" in one configuration and "95% of budget" in
 * another while painting the same amber.
 */
function glanceStatus(severity: GlanceSeverity): TrayUsageMeterSummary["status"] {
  return severity
}

/**
 * The compact usage fragment appended to the OS tooltip
 * (`TrayDisplayPrefs.showUsageInTooltip`).
 *
 * For a spend or token metric this is the projection's own readout, because
 * a per-account quota line cannot express "what I spent". For quota it stays
 * the pinned/worst account line it has always been.
 */
export function usageTooltipFragment(
  usage: TrayUsageSnapshot | null | undefined,
  now: number,
  metric: UsageGlanceMetric = "quota"
): string | null {
  if (!usage) return null
  if (metric === "spend" || metric === "tokens" || metric === "budget") {
    if (!usage.glance) return null
    return formatTaskbarUsage(usage.glance, metric)
  }
  const account = selectDisplayAccount(usage.accounts, usage.selectedKey)
  return account ? formatAccountLine(account, now) : null
}

/**
 * The shortest readout for the taskbar surfaces (icon badge / macOS title).
 *
 * `quota` reads the pinned account's meter, exactly as before. Every other
 * metric reads the glance projection, which already owns the rule that a
 * partially-priced window renders as a lower bound and an entirely unpriced
 * one renders as nothing at all rather than as a confident zero.
 */
export function usageShortText(
  usage: TrayUsageSnapshot | null | undefined,
  metric: UsageGlanceMetric = "quota"
): { text: string; status: TrayUsageMeterSummary["status"] } | null {
  if (!usage) return null
  if (metric === "spend" || metric === "tokens" || metric === "budget") {
    if (!usage.glance) return null
    const text = formatTaskbarUsage(usage.glance, metric)
    return text ? { text, status: glanceStatus(glanceSeverity(usage.glance)) } : null
  }
  const account = selectDisplayAccount(usage.accounts, usage.selectedKey)
  if (!account?.worst) return null
  const text = formatMeterShort(account.worst)
  return text ? { text, status: account.worst.status } : null
}
