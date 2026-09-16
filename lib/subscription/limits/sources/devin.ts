// Devin subscription-quota limits source.
//
// Devin (Cognition) bills Pro/Teams seats by quota: a daily and/or weekly
// utilization window, ACU (agent compute unit) consumption, credit balances
// (prompt/flow/flex), an overage balance, and optional auto top-up. The Devin
// CLI's own `/usage` screen reads all of this from one Connect-RPC endpoint:
//
//   POST {api_server_url}/exa.seat_management_pb.SeatManagementService/GetUserStatus
//   Content-Type: application/json
//   { "metadata": { apiKey, ideName, ideVersion, extensionName, extensionVersion } }
//
// verified against devin-cli 3000.10.27 (2026-09). Three facts drive this file:
//
//   1. The host is `api_server_url` from `~/.local/share/devin/credentials.toml`
//      (default `https://server.codeium.com`) — NOT `devin_api_url`
//      (`api.devin.ai`), where the `exa.*` services 404. `windsurf_api_key` is
//      the bearer-equivalent `apiKey` inside the metadata envelope.
//   2. The envelope REQUIRES all five metadata fields — a partial body (even
//      `apiKey` alone) 400s with Connect `invalid_argument`. The values are
//      presence-checked, not validated; they describe the credential's owning
//      client, so they mirror what devin-cli itself sends.
//   3. `planStatus` is proto3-JSON: absent fields mean "not set" (ints may
//      arrive as strings), and `available*Credits: -1` is the unlimited
//      sentinel — never render it as a real balance.
//
// Like the Anthropic/Codex endpoints this is an internal contract with no
// stability guarantee, so failures surface as `error` snapshots rather than
// silently degrading to "no data".

import { balanceMeter, errorLimits, windowMeter } from "../meters"

import type {
  LimitsMeter,
  LimitsSource,
  LimitsSourceContext,
  ProviderLimits,
} from "@/types/subscription"

/** Default seat-management host (`api_server_url` in credentials.toml). */
export const DEVIN_API_BASE = "https://server.codeium.com"

/** Connect-RPC path for the account plan/quota read. */
const GET_USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus"

/** Hosts that serve the seat-management Connect API. */
const DEVIN_API_HOST_RE = /^https?:\/\/([a-z0-9-]+\.)?codeium\.com(\/|$)/i

/**
 * Client identity the envelope carries. Values are presence-checked only, so
 * they describe the credential's owning client (the Devin CLI) rather than
 * Cognia — the same fields devin-cli itself POSTs.
 */
const REQUEST_METADATA = {
  ideName: "devin-cli",
  ideVersion: "3000.10.27",
  extensionName: "devin",
  extensionVersion: "3000.10.27",
} as const

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

/** Unix seconds (possibly a numeric string, per proto3-JSON) → epoch ms. */
function unixMs(v: unknown): number | null {
  const n = num(v)
  return n != null && n > 0 ? n * 1000 : null
}

/** ISO-8601 timestamp → epoch ms. */
function isoMs(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

interface DevinRequestUsageAction {
  label?: unknown
  url?: unknown
}

interface DevinPlanInfo {
  planName?: unknown
  teamsTier?: unknown
  hideDailyQuota?: unknown
  gracePeriodEnd?: unknown
  devinInfo?: { requestUsageAction?: DevinRequestUsageAction }
}

interface DevinTopUpStatus {
  topUpEnabled?: unknown
  monthlyTopUpAmount?: unknown
  topUpSpent?: unknown
  topUpCriteriaMet?: unknown
}

/** `userStatus.planStatus` — every field optional (proto3-JSON). */
export interface DevinPlanStatus {
  planInfo?: DevinPlanInfo
  planStart?: unknown
  planEnd?: unknown
  dailyQuotaRemainingPercent?: unknown
  weeklyQuotaRemainingPercent?: unknown
  dailyQuotaResetAtUnix?: unknown
  weeklyQuotaResetAtUnix?: unknown
  acuConsumed?: unknown
  acuLimit?: unknown
  overageBalanceMicros?: unknown
  availablePromptCredits?: unknown
  availableFlowCredits?: unknown
  availableFlexCredits?: unknown
  usedPromptCredits?: unknown
  usedFlowCredits?: unknown
  usedFlexCredits?: unknown
  topUpStatus?: DevinTopUpStatus
}

/** `userStatus` — the account identity plus its plan. */
export interface DevinUserStatus {
  email?: unknown
  teamsTier?: unknown
  planStatus?: DevinPlanStatus
}

// Meter ids are "devin/<kind>" prefixed (the codexStatusLimits convention) so
// they never collide with the TUI's built-in-id label map or id-keyed
// consumers like the billing block; every meter carries its own `label`.
const CREDIT_SPECS = [
  {
    available: "availablePromptCredits",
    used: "usedPromptCredits",
    id: "devin/promptCredits",
    labelKey: "subscription.limits.meter.promptCredits",
    label: "Prompt credits",
  },
  {
    available: "availableFlowCredits",
    used: "usedFlowCredits",
    id: "devin/flowCredits",
    labelKey: "subscription.limits.meter.flowCredits",
    label: "Flow credits",
  },
  {
    available: "availableFlexCredits",
    used: "usedFlexCredits",
    id: "devin/flexCredits",
    labelKey: "subscription.limits.meter.flexCredits",
    label: "Flex credits",
  },
] as const

function remainingWindow(
  id: string,
  labelKey: string,
  label: string,
  remaining: number | null,
  resetAt: number | null
): LimitsMeter | null {
  if (remaining == null) return null
  // remaining% → used% (the panel renders utilization). Clamp so a >100%
  // remaining report can't read as negative usage.
  const clamped = Math.min(100, Math.max(0, remaining))
  const meter = windowMeter(id, labelKey, { utilization: 100 - clamped, resetAt })
  meter.label = label
  return meter
}

function creditMeter(
  plan: DevinPlanStatus,
  spec: (typeof CREDIT_SPECS)[number]
): LimitsMeter | null {
  const available = num(plan[spec.available])
  if (available == null) return null
  const used = num(plan[spec.used]) ?? undefined
  // -1 is the unlimited sentinel (Pro plans report it for prompt credits):
  // no balance to render, so the meter carries the state in its label only.
  if (available < 0) {
    return {
      id: spec.id,
      labelKey: spec.labelKey,
      label: `${spec.label} (unlimited)`,
      kind: "balance",
      usedPct: null,
      used,
      unit: "credits",
      status: "ok",
    }
  }
  const meter = balanceMeter(
    {
      accountId: "",
      providerKey: "devin",
      fetchedAt: 0,
      kind: "credit",
      raw: {},
      remaining: available,
      used,
      unit: "credits",
    },
    { id: spec.id, labelKey: spec.labelKey }
  )
  meter.label = spec.label
  return meter
}

/**
 * Project `planStatus` into normalized meters. Every field is optional and
 * stays absent unless the API reported it — nothing is fabricated.
 */
export function devinPlanStatusMeters(plan: DevinPlanStatus): LimitsMeter[] {
  const meters: LimitsMeter[] = []
  const info = plan.planInfo

  if (info?.hideDailyQuota !== true) {
    const daily = remainingWindow(
      "devin/daily",
      "subscription.limits.meter.daily",
      "Daily quota",
      num(plan.dailyQuotaRemainingPercent),
      unixMs(plan.dailyQuotaResetAtUnix)
    )
    if (daily) meters.push(daily)
  }
  const weekly = remainingWindow(
    "devin/weekly",
    "subscription.limits.meter.weekly",
    "Weekly quota",
    num(plan.weeklyQuotaRemainingPercent),
    unixMs(plan.weeklyQuotaResetAtUnix)
  )
  if (weekly) meters.push(weekly)

  const acuConsumed = num(plan.acuConsumed)
  const acuLimit = num(plan.acuLimit)
  if (acuConsumed != null && acuLimit != null && acuLimit > 0) {
    // ACU consumption tracks the billing plan, so it resets at plan end.
    const acu = windowMeter("devin/acu", "subscription.limits.meter.acu", {
      utilization: (acuConsumed / acuLimit) * 100,
      resetAt: isoMs(plan.planEnd),
    })
    acu.label = "ACU usage"
    meters.push(acu)
  }

  const overageMicros = num(plan.overageBalanceMicros)
  if (overageMicros != null) {
    const overage = balanceMeter(
      {
        accountId: "",
        providerKey: "devin",
        fetchedAt: 0,
        kind: "credit",
        raw: {},
        remaining: overageMicros / 1e6,
        currency: "USD",
      },
      { id: "devin/overage", labelKey: "subscription.limits.meter.overage" }
    )
    overage.label = "Overage balance"
    meters.push(overage)
  }

  for (const spec of CREDIT_SPECS) {
    const meter = creditMeter(plan, spec)
    if (meter) meters.push(meter)
  }

  // Auto top-up spends real money on demand; surface it only when enabled and
  // the cap is known. Amounts are micros USD, same scale as overageBalanceMicros.
  const topUp = plan.topUpStatus
  const topUpCap = num(topUp?.monthlyTopUpAmount)
  const topUpSpent = num(topUp?.topUpSpent)
  if (topUp?.topUpEnabled === true && topUpCap != null && topUpCap > 0) {
    const meter = balanceMeter(
      {
        accountId: "",
        providerKey: "devin",
        fetchedAt: 0,
        kind: "credit",
        raw: {},
        total: topUpCap / 1e6,
        used: topUpSpent != null ? topUpSpent / 1e6 : undefined,
        currency: "USD",
      },
      { id: "devin/topUp", labelKey: "subscription.limits.meter.topUp" }
    )
    meter.label = "Auto top-up"
    meters.push(meter)
  }

  return meters
}

/** The vendor's own upsell hint — only when a window/balance is actually tight. */
function requestUsageNotice(plan: DevinPlanStatus, meters: LimitsMeter[]): string | undefined {
  const tight = meters.some(
    (m) => m.status === "warn" || m.status === "crit" || m.status === "exceeded"
  )
  if (!tight) return undefined
  const action = plan.planInfo?.devinInfo?.requestUsageAction
  const label = typeof action?.label === "string" ? action.label : ""
  const url = typeof action?.url === "string" ? action.url : ""
  const text = [label, url].filter(Boolean).join(" ")
  return text || undefined
}

/** Account label from the response identity (`Devin · email · plan`). */
function devinAccountLabel(status: DevinUserStatus): string | undefined {
  const planName = status.planStatus?.planInfo?.planName
  const parts = [
    "Devin",
    typeof status.email === "string" && status.email ? status.email : undefined,
    typeof planName === "string" && planName ? planName : undefined,
  ].filter(Boolean)
  return parts.length > 1 ? parts.join(" · ") : undefined
}

/**
 * `userStatus` → snapshot. `null` when the response carries no planStatus —
 * the account simply has nothing to report (distinct from a failed query).
 */
export function parseDevinUserStatus(
  body: string,
  ctx: Pick<LimitsSourceContext, "accountId" | "accountLabel" | "now">
): ProviderLimits | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const status = (parsed as { userStatus?: DevinUserStatus }).userStatus
  if (!status || typeof status !== "object" || !status.planStatus) return null
  const meters = devinPlanStatusMeters(status.planStatus)
  const notice = requestUsageNotice(status.planStatus, meters)
  return {
    provider: "devin",
    accountId: ctx.accountId,
    accountLabel: devinAccountLabel(status) ?? ctx.accountLabel,
    fetchedAt: ctx.now,
    meters,
    ...(notice ? { notice } : {}),
  }
}

export const devinLimitsSource: LimitsSource = {
  key: "devin",

  matches(q) {
    return (
      q.provider === "devin" ||
      q.providerKey === "devin" ||
      (typeof q.baseUrl === "string" && DEVIN_API_HOST_RE.test(q.baseUrl))
    )
  },

  async fetch(ctx: LimitsSourceContext): Promise<ProviderLimits | null> {
    if (!ctx.token) return null
    // The quota read is a Connect-RPC POST — decline when the environment only
    // wires the GET passthrough rather than fake one.
    if (!ctx.authedRequest) return null
    const base = (ctx.baseUrl ?? DEVIN_API_BASE).trim().replace(/\/+$/, "") || DEVIN_API_BASE

    let res: { status: number; body: string }
    try {
      res = await ctx.authedRequest({
        url: `${base}${GET_USER_STATUS_PATH}`,
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ metadata: { apiKey: ctx.token, ...REQUEST_METADATA } }),
      })
    } catch (err) {
      return errorLimits(ctx, "devin", err instanceof Error ? err.message : String(err))
    }
    if (res.status < 200 || res.status >= 300) {
      // Trim a noisy error body — the panel renders this inline.
      const body = res.body.length > 500 ? `${res.body.slice(0, 500)}…` : res.body
      return errorLimits(ctx, "devin", `${res.status}: ${body}`)
    }

    const snapshot = parseDevinUserStatus(res.body, ctx)
    if (!snapshot) return null
    return snapshot
  },
}
