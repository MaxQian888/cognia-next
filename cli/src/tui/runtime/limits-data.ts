/**
 * CLI-side limits enumerator. The desktop reads accounts from the Rust keyring
 * vault (`lib/subscription/limits/aggregate.ts`); the CLI has no Tauri, so it
 * derives "accounts" from its own `~/.cognia/config.json` providers instead.
 * Both feed the SAME source registry + meters, so the unified `/limits` panel
 * renders identically.
 *
 * Each configured provider with a credential is mapped to a `LimitsSourceContext`
 * and run through `resolveLimitsSources` (Anthropic windows, Codex windows, or a
 * credit-balance meter). The active provider's snapshot is pinned first.
 */
import { resolveLimitsSources } from "@/lib/subscription/limits/registry"
import { runCustomLimitsSources } from "@/lib/subscription/limits/custom/runner"
import { balanceMeter, windowMeter } from "@/lib/subscription/limits/meters"
import type { CanonicalAgentEvent } from "@cognia/agent-config-types/agent-execution"
import type { CodexAppServerStatus } from "@/lib/ai/agent/external/codex-app-server-client"

import type { LimitsSourceContext, ProviderId, ProviderLimits } from "@/types/subscription"
import type { ResolvedConfig } from "../../config/schema"
import { createCliTranslator, type CliLocale } from "../i18n"

type NativeRateLimit = Extract<CanonicalAgentEvent, { kind: "rate-limit" }> & {
  receivedAt?: number
}

/** Pure mapping of quota pushed by the active runtime; no credential probes. */
export function agentStatusLimits(
  provider: string,
  events: Record<string, NativeRateLimit>,
  now: number,
  locale?: CliLocale
): ProviderLimits[] {
  const t = createCliTranslator(locale, "cliUiCommon")
  const receivedTimes = Object.values(events)
    .map((event) => event.receivedAt)
    .filter((time): time is number => typeof time === "number" && Number.isFinite(time))
  const snapshot: ProviderLimits = {
    provider,
    accountId: provider,
    fetchedAt: receivedTimes.length > 0 ? Math.max(...receivedTimes) : now,
    notice: t("agentLimits.latestReport"),
    meters: [],
  }
  const resetTime = (seconds?: number) =>
    typeof seconds === "number" && Number.isFinite(seconds) ? seconds * 1000 : null
  const meterStatus = (status?: NativeRateLimit["status"]) =>
    status === "rejected"
      ? "crit"
      : status === "allowed_warning"
        ? "warn"
        : status === "allowed"
          ? "ok"
          : "unknown"
  for (const [key, event] of Object.entries(events)) {
    const label = event.rateLimitType ?? key
    snapshot.meters.push({
      id: `native/${key}`,
      label: `${label} · ${t(`agentLimits.${event.status}`)}`,
      kind: "window",
      usedPct:
        typeof event.utilization === "number" && Number.isFinite(event.utilization)
          ? event.utilization * 100
          : null,
      resetAt: resetTime(event.resetsAt),
      status: meterStatus(event.status),
    })
    const usingOverage = event.isUsingOverage ?? event.overageInUse
    if (
      event.overageStatus !== undefined ||
      event.overageResetsAt !== undefined ||
      usingOverage !== undefined ||
      event.overageDisabledReason !== undefined
    ) {
      snapshot.meters.push({
        id: `native/${key}/overage`,
        label: [
          label,
          t("agentLimits.overage"),
          event.overageStatus && t(`agentLimits.${event.overageStatus}`),
          usingOverage !== undefined &&
            t(usingOverage ? "agentLimits.overageInUse" : "agentLimits.overageNotInUse"),
          event.overageDisabledReason &&
            t("agentLimits.overageDisabledReason", { reason: event.overageDisabledReason }),
        ]
          .filter(Boolean)
          .join(" · "),
        kind: "window",
        usedPct: null,
        resetAt: resetTime(event.overageResetsAt),
        status: meterStatus(event.overageStatus),
      })
    }
  }
  return [snapshot]
}

/** The native connection owns its account; CLI provider credentials are unrelated. */
export function codexStatusLimits(
  status: CodexAppServerStatus,
  now: number,
  locale?: CliLocale
): ProviderLimits[] {
  const t = createCliTranslator(locale, "cliUiCommon")
  const error = status.accountError ?? status.rateLimitsError
  const snapshot: ProviderLimits = {
    provider: "codex",
    accountId: "codex",
    accountLabel: ["Codex", status.account?.email, status.account?.planType]
      .filter(Boolean)
      .join(" · "),
    fetchedAt: status.accountFetchedAt ?? now,
    meters: [],
    ...(error ? { error } : {}),
  }
  if (error || status.account === null || status.account?.type === "apiKey") return [snapshot]
  const buckets =
    status.rateLimitsByLimitId && Object.keys(status.rateLimitsByLimitId).length > 0
      ? Object.entries(status.rateLimitsByLimitId)
      : status.rateLimits
        ? [[status.rateLimits.limitId ?? "codex", status.rateLimits] as const]
        : []
  for (const [id, limits] of buckets) {
    const label = limits.limitName ?? id
    for (const [kind, win] of [
      ["session", limits.primary],
      ["weekly", limits.secondary],
    ] as const) {
      if (!win || !Number.isFinite(win.usedPercent)) continue
      const meter = windowMeter(`${id}/${kind}`, `subscription.limits.meter.${kind}`, {
        utilization: win.usedPercent,
        resetAt:
          typeof win.resetsAt === "number" && Number.isFinite(win.resetsAt)
            ? win.resetsAt * 1000
            : null,
      })
      const minutes = win.windowDurationMins
      const duration =
        minutes && minutes > 0
          ? minutes % 1440 === 0
            ? t("codexLimits.days", { count: minutes / 1440 })
            : minutes % 60 === 0
              ? t("codexLimits.hours", { count: minutes / 60 })
              : t("codexLimits.minutes", { count: minutes })
          : kind === "session"
            ? t("codexLimits.primaryWindow")
            : t("codexLimits.secondaryWindow")
      meter.label = `${label} · ${duration}`
      snapshot.meters.push(meter)
    }
    if (limits.credits) {
      const credits = limits.credits
      const balance = credits.balance?.trim() ? Number(credits.balance) : undefined
      const meter = balanceMeter(
        {
          accountId: "codex",
          providerKey: "codex",
          fetchedAt: snapshot.fetchedAt,
          kind: "credit",
          raw: {},
          remaining:
            !credits.unlimited && typeof balance === "number" && Number.isFinite(balance)
              ? balance
              : undefined,
          unit: t("codexLimits.creditUnit"),
        },
        { id: `${id}/credits` }
      )
      meter.label = `${label} · ${t(credits.unlimited ? "codexLimits.unlimitedCredits" : "codexLimits.credits")}`
      if (credits.unlimited) meter.status = "ok"
      snapshot.meters.push(meter)
    }
    const individual = limits.individualLimit
    if (individual && Number.isFinite(individual.remainingPercent)) {
      const meter = windowMeter(`${id}/individual`, "", {
        utilization: 100 - individual.remainingPercent,
        resetAt: Number.isFinite(individual.resetsAt) ? individual.resetsAt * 1000 : null,
      })
      meter.label = `${label} · ${t("codexLimits.individualSpendingLimit")}`
      snapshot.meters.push(meter)
    }
    if (limits.spendControlReached)
      snapshot.meters.push({
        id: `${id}/spending-control`,
        label: `${label} · ${t("codexLimits.spendingLimitReached")}`,
        kind: "window",
        usedPct: null,
        status: "crit",
      })
  }
  if (status.ordinaryUsageAllowed === false)
    snapshot.meters.push({
      id: "ordinary-usage",
      label: `Codex · ${t("codexLimits.ordinaryUsageBlocked")}`,
      kind: "window",
      usedPct: null,
      status: "crit",
    })
  return [snapshot]
}

/** Uses only the already-connected adapter; never creates a process or thread. */
export async function loadCodexLimits(
  agentId: string,
  now: number,
  locale?: CliLocale
): Promise<ProviderLimits[]> {
  const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
  const adapter = getExternalAgentManager({ healthCheckInterval: 0 }).getCodexAppServerAdapter(
    agentId
  )
  if (!adapter?.isConnected())
    throw new Error(createCliTranslator(locale, "cliUiCommon")("codexLimits.notConnected"))
  await adapter.refreshAccount()
  return codexStatusLimits(adapter.getStatus(), now, locale)
}

/** Default base URLs for providers the CLI knows by id (preset-less). Covers
 * credit-balance hosts and the Coding Plan quota hosts (glm/minimax/kimi-coding)
 * so a provider configured by id alone still matches its catalog descriptor. */
const DEFAULT_BASE_URLS: Record<string, string> = {
  moonshot: "https://api.moonshot.cn/v1",
  kimi: "https://api.moonshot.cn/v1",
  "kimi-coding": "https://api.kimi.com",
  deepseek: "https://api.deepseek.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  novita: "https://api.novita.ai/v3/openai",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  stepfun: "https://api.stepfun.com/v1",
  glm: "https://api.z.ai",
  minimax: "https://api.minimaxi.com",
}

/** Map a CLI provider id onto the vault `ProviderId` the windowed sources match. */
export function mapCliProvider(id: string): ProviderId {
  if (id === "anthropic") return "anthropic"
  if (id === "openai" || id === "codex" || id === "chatgpt") return "codex"
  // Other providers resolve through the declarative catalog (Coding Plan window
  // sources like glm/minimax/kimi-coding) or the balance fallthrough, both of
  // which match on `providerKey`/`baseUrl` and ignore this field — "opencode" is
  // just a harmless placeholder.
  return "opencode"
}

export interface CliLimitsDeps {
  config: ResolvedConfig
  now: number
  authedGet: (url: string, headers?: Record<string, string>) => Promise<string>
  /** CLI active provider id (`config.provider`) — pinned first. */
  activeProvider?: string
}

/**
 * Resolve the unified limits for every configured CLI provider that carries a
 * credential. Providers with no usable source or no snapshot are dropped. Never
 * throws — a single provider's failure is isolated.
 */
export async function buildCliLimits(deps: CliLimitsDeps): Promise<ProviderLimits[]> {
  const providers = deps.config.providers ?? {}
  const providerLoads = Object.entries(providers).map(async ([id, p]) => {
    const token = (p?.authToken ?? p?.apiKey) || null
    if (!token) return null

    const provider = mapCliProvider(id)
    const providerKey = id
    const baseUrl = p?.baseURL ?? DEFAULT_BASE_URLS[id]

    const sources = resolveLimitsSources({ provider, providerKey, baseUrl })
    if (sources.length === 0) return null

    const ctx: LimitsSourceContext = {
      provider,
      accountId: id,
      accountLabel: id,
      token,
      baseUrl,
      providerKey,
      authedGet: deps.authedGet,
      now: deps.now,
    }

    for (const source of sources) {
      let snapshot: ProviderLimits | null
      try {
        snapshot = await source.fetch(ctx)
      } catch {
        snapshot = null
      }
      if (snapshot && (snapshot.meters.length > 0 || snapshot.error)) {
        return snapshot
      }
    }
    return null
  })

  const customSources = deps.config.customLimitsSources ?? []
  const customLoad =
    customSources.length > 0
      ? runCustomLimitsSources(customSources, {
          authedGet: deps.authedGet,
          now: () => deps.now,
        })
      : Promise.resolve([])
  const [providerResults, customSnaps] = await Promise.all([Promise.all(providerLoads), customLoad])
  const results = providerResults.filter(
    (snapshot): snapshot is ProviderLimits => snapshot !== null
  )

  // Guarantee the active provider is always represented, even when it has no
  // usable source or returned no data. Without this, the panel would collapse to
  // "only the providers that happened to return data" (typically a credit
  // provider like DeepSeek), making it look like that provider is always active
  // no matter which one really is.
  const active = deps.activeProvider
  if (active && !results.some((r) => r.accountId === active)) {
    results.push({
      provider: active,
      accountId: active,
      accountLabel: active,
      fetchedAt: deps.now,
      meters: [],
    })
  }

  // Pin the active provider's snapshot first (stable for the rest).
  results.sort((a, b) => {
    const aw = a.accountId === deps.activeProvider ? 0 : 1
    const bw = b.accountId === deps.activeProvider ? 0 : 1
    return aw - bw
  })

  // Append user-defined custom sources (self-contained; own baseUrl + token).
  results.push(...customSnaps)
  return results
}

/** Plain node-`fetch` authed GET — the CLI has no CORS, so no Tauri passthrough. */
export async function nodeAuthedGet(
  url: string,
  headers: Record<string, string> = {}
): Promise<string> {
  const res = await fetch(url, { headers })
  return await res.text()
}
