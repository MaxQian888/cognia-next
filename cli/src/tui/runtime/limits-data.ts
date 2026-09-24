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
 *
 * External agents join the same enumeration: `providerIdForPreset` links an
 * agent preset to its subscription provider, and a provider-scoped credential
 * resolver (`EXTERNAL_CREDENTIAL_PROVIDERS`) seeds a synthetic provider entry
 * from the agent's own credential store (e.g. the Devin CLI's
 * `credentials.toml`). Adding quota support for another external agent is
 * data-only: a `providerIdForPreset` case, a credential resolver, and a limits
 * source — no new branches in the controller.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { parse as parseToml } from "smol-toml"

import { providerIdForPreset } from "@/lib/ai/agent/external/config/preset-provider"
import { resolveLimitsSources } from "@/lib/subscription/limits/registry"
import { runCustomLimitsSources } from "@/lib/subscription/limits/custom/runner"
import { balanceMeter, windowMeter } from "@/lib/subscription/limits/meters"
import type { CanonicalAgentEvent } from "@cognia/agent-config-types/agent-execution"
import type { CodexAppServerStatus } from "@/lib/ai/agent/external/runtimes/codex/codex-app-server-client"

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
  devin: "https://server.codeium.com",
}

/** Map a CLI provider id onto the vault `ProviderId` the windowed sources match. */
export function mapCliProvider(id: string): ProviderId {
  if (id === "anthropic") return "anthropic"
  if (id === "openai" || id === "codex" || id === "chatgpt") return "codex"
  if (id === "devin") return "devin"
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
  /** POST-capable seam for Connect-RPC sources; defaults to `nodeAuthedRequest`. */
  authedRequest?: NonNullable<LimitsSourceContext["authedRequest"]>
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
      authedRequest: deps.authedRequest ?? nodeAuthedRequest,
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

/** node-`fetch` counterpart of `subscription_authed_request` (status + body). */
export async function nodeAuthedRequest(request: {
  url: string
  method?: "GET" | "POST"
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}): Promise<{ status: number; body: string }> {
  const res = await fetch(request.url, {
    method: request.method ?? "GET",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(request.timeoutMs ?? 15_000),
  })
  return { status: res.status, body: await res.text() }
}

// ---------------------------------------------------------------------------
// External-agent credentials. An agent preset is linked to its subscription
// provider via `providerIdForPreset`; a resolver here knows how to read that
// provider's token out of the agent's own store (env first, native CLI files
// as fallback) so the SAME source registry answers its quota. A resolver entry
// + a limits source is the whole cost of supporting another agent.
// ---------------------------------------------------------------------------

/** A credential recovered from an external agent's own store. */
export interface ExternalAgentCredential {
  token: string
  baseUrl?: string
}

export interface ExternalCredentialDeps {
  env?: Record<string, string | undefined>
  /** Override the credentials file path (tests). */
  credentialsPath?: string
  /** File-read seam (tests); returns `null` when the file is absent/unreadable. */
  readFile?: (path: string) => Promise<string | null>
}

const DEVIN_CREDENTIALS_RELATIVE_PATH = ".local/share/devin/credentials.toml"

const defaultReadFile = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8")
  } catch {
    return null
  }
}

/** Extract the quota-relevant fields from Devin's `credentials.toml`. */
export function parseDevinCredentialsToml(text: string): {
  apiKey?: string
  apiServerUrl?: string
} {
  try {
    const parsed = parseToml(text) as Record<string, unknown>
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined)
    return {
      apiKey: str(parsed.windsurf_api_key),
      apiServerUrl: str(parsed.api_server_url),
    }
  } catch {
    return {}
  }
}

/**
 * Devin's quota credential: `DEVIN_API_KEY`/`DEVIN_TOKEN` (+ `DEVIN_BASE_URL`)
 * from the environment first — the same keys the spawned `devin acp` process
 * is fed — then the Devin CLI's own `credentials.toml` (`windsurf_api_key`,
 * `api_server_url`). `null` when neither source yields a token.
 */
export async function resolveDevinCredential(
  deps: ExternalCredentialDeps = {}
): Promise<ExternalAgentCredential | null> {
  const env = deps.env ?? process.env
  let token = env.DEVIN_API_KEY?.trim() || env.DEVIN_TOKEN?.trim() || undefined
  let baseUrl = env.DEVIN_BASE_URL?.trim() || undefined
  if (!token || !baseUrl) {
    const reader = deps.readFile ?? defaultReadFile
    const path = deps.credentialsPath ?? join(homedir(), DEVIN_CREDENTIALS_RELATIVE_PATH)
    const text = await reader(path)
    if (text) {
      const parsed = parseDevinCredentialsToml(text)
      token ??= parsed.apiKey
      baseUrl ??= parsed.apiServerUrl
    }
  }
  if (!token) return null
  return { token, baseUrl }
}

interface ExternalCredentialProvider {
  /** Read the agent-linked provider's token out of its own credential store. */
  resolve: (deps: ExternalCredentialDeps) => Promise<ExternalAgentCredential | null>
  /** `cliUiCommon` notice key shown when no credential resolves. */
  missingNoticeKey: string
}

/** Provider → its external-agent credential resolver. Extend per agent. */
const EXTERNAL_CREDENTIAL_PROVIDERS: Record<string, ExternalCredentialProvider> = {
  devin: { resolve: resolveDevinCredential, missingNoticeKey: "devinLimits.noCredential" },
}

const hasCredential = (p: { apiKey?: string; authToken?: string } | undefined) =>
  Boolean(p?.authToken ?? p?.apiKey)

/**
 * Limits for an external-agent backend. The agent's linked subscription
 * provider is queried through the SAME source registry as configured
 * providers: when `config.providers` lacks an entry for it, the agent's own
 * credential store seeds a synthetic one; when nothing resolves, the
 * placeholder keeps the historical "unavailable" notice (or the agent's more
 * specific `missingNoticeKey`). Configured providers are enumerated alongside
 * so the panel still shows "all configured providers".
 */
export async function loadExternalAgentLimits(
  config: ResolvedConfig,
  now: number,
  activeProvider: string,
  preset: string | undefined,
  /** `cliUiCommon` notice key for the placeholder when nothing was queried. */
  emptyNoticeKey: string,
  deps: {
    authedGet?: CliLimitsDeps["authedGet"]
    authedRequest?: CliLimitsDeps["authedRequest"]
    credentialDeps?: ExternalCredentialDeps
  } = {}
): Promise<ProviderLimits[]> {
  const t = createCliTranslator(config.locale, "cliUiCommon")
  const providers: ResolvedConfig["providers"] = { ...config.providers }
  const extras: ProviderLimits[] = []
  let queried = false

  const linked = providerIdForPreset(preset)
  if (linked) {
    if (hasCredential(providers[linked])) {
      queried = true
    } else {
      const resolver = EXTERNAL_CREDENTIAL_PROVIDERS[linked]
      const cred = resolver ? await resolver.resolve(deps.credentialDeps ?? {}) : null
      if (cred) {
        queried = true
        providers[linked] = cred.baseUrl
          ? { authToken: cred.token, baseURL: cred.baseUrl }
          : { authToken: cred.token }
      } else if (resolver) {
        extras.push({
          provider: linked,
          accountId: linked,
          accountLabel: preset,
          fetchedAt: now,
          meters: [],
          notice: t(resolver.missingNoticeKey),
        })
      }
    }
  }

  const results = await buildCliLimits({
    config: { ...config, providers },
    now,
    authedGet: deps.authedGet ?? nodeAuthedGet,
    authedRequest: deps.authedRequest,
    activeProvider,
  })
  const snapshots = [...extras, ...results]
  const sawData = snapshots.some((s) => s.meters.length > 0 || s.error || s.notice)
  if (!sawData && !queried) {
    // Nothing was queryable — keep the historical external-agent notice.
    const placeholder = snapshots.find((s) => s.accountId === activeProvider)
    if (placeholder) placeholder.notice = t(emptyNoticeKey)
    else
      snapshots.unshift({
        provider: activeProvider,
        accountId: activeProvider,
        accountLabel: preset,
        fetchedAt: now,
        meters: [],
        notice: t(emptyNoticeKey),
      })
  }
  return snapshots
}
