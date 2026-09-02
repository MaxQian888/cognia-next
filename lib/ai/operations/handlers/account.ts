/**
 * Account surfaces: `balance.read`, `quota.read`, `rate-limits.read`,
 * `usage.provider.read` and `usage.local.read`.
 *
 * Balance and quota delegate to the subscription registries the settings
 * screens already use (`findBalanceAdapter`, `resolveLimitsSources`), so a
 * vendor is added there once and both the UI and this executor see it.
 * Rate limits are derived from the headers of a cheap authenticated GET.
 * Provider usage is bound per vendor to its documented usage endpoint, and
 * local usage reads the Dexie `sessionUsage` ledger this app writes.
 */

import type { BalanceQuery, BalanceSnapshot, LimitsMeter, ProviderId } from "@/types/subscription"
import { getDb } from "@/lib/db/schema"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { failureForStatus } from "@/lib/provider-diagnostics/probe"
import { findBalanceAdapter } from "@/lib/subscription/balance/registry"
import { resolveLimitsSources } from "@/lib/subscription/limits/registry"
import { aggregateByModel, type ModelUsageRow } from "@/lib/usage/session-analytics"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { ProviderOperationFailureError } from "../failure"
import type { ProviderOperationHandlerRegistration } from "../registry"
import { providerRequest } from "./http"

const DAY_MS = 86_400_000

/**
 * The key the subscription registries know a vendor by. Relay ids carry a
 * wire suffix (`<vendor>-anthropic`), the registries key on the vendor.
 */
export function registryProviderKey(providerId: string): string {
  return providerId.replace(/-anthropic(-intl)?$/, "")
}

function requireToken(provider: ResolvedProvider): string {
  if (!provider.apiKey) {
    throw new ProviderOperationFailureError({
      code: "authentication",
      retryable: false,
      message: `${provider.providerId} has no credential to query the account with`,
    })
  }
  return provider.apiKey
}

// ---- balance ----------------------------------------------------------------------

export type BalanceReadOutput = BalanceSnapshot

export const balanceReadHandler: ProviderOperationHandlerRegistration<
  { deploymentRef?: string },
  BalanceReadOutput
> = {
  operationId: "balance.read",
  providerMatch: { kind: "any" },
  support: "native",
  async handler({ provider, request, signal }) {
    const providerKey = registryProviderKey(provider.providerId)
    const adapter = findBalanceAdapter({ providerKey, baseUrl: provider.baseURL })
    if (!adapter) {
      throw new ProviderOperationFailureError({
        code: "capability-unsupported",
        retryable: false,
        message: `no balance adapter matches ${provider.providerId}`,
      })
    }
    const query: BalanceQuery = {
      accountId: request.input?.deploymentRef ?? request.deploymentRef ?? provider.providerId,
      providerKey: adapter.key,
      baseUrl: provider.baseURL ?? "",
      token: requireToken(provider),
    }
    const descriptor = adapter.request(query)
    const response = await proxyFetch(descriptor.url, {
      method: "GET",
      headers: descriptor.headers,
      ...(signal ? { signal } : {}),
    })
    const body = await response.text()
    if (!response.ok) throw new ProviderOperationFailureError(failureForStatus(response.status))
    return adapter.parse(response.status, body, query)
  },
}

// ---- quota ------------------------------------------------------------------------

export interface QuotaReadOutput {
  source: string
  fetchedAt: number
  meters: LimitsMeter[]
}

export const quotaReadHandler: ProviderOperationHandlerRegistration<
  { deploymentRef?: string },
  QuotaReadOutput
> = {
  operationId: "quota.read",
  providerMatch: { kind: "any" },
  support: "native",
  async handler({ provider, request, signal }) {
    const providerKey = registryProviderKey(provider.providerId)
    const sources = resolveLimitsSources({
      provider: provider.providerId,
      providerKey,
      baseUrl: provider.baseURL,
    })
    if (sources.length === 0) {
      throw new ProviderOperationFailureError({
        code: "capability-unsupported",
        retryable: false,
        message: `no quota source matches ${provider.providerId}`,
      })
    }
    const token = requireToken(provider)
    const authedGet = async (url: string, headers?: Record<string, string>) => {
      const response = await proxyFetch(url, {
        method: "GET",
        headers: headers ?? {},
        ...(signal ? { signal } : {}),
      })
      const body = await response.text()
      if (!response.ok) throw new ProviderOperationFailureError(failureForStatus(response.status))
      return body
    }
    const now = Date.now()
    for (const source of sources) {
      const limits = await source.fetch({
        provider: provider.providerId as ProviderId,
        accountId: request.input?.deploymentRef ?? request.deploymentRef ?? provider.providerId,
        token,
        baseUrl: provider.baseURL,
        providerKey,
        ...(provider.headers ? { presetHeaders: provider.headers } : {}),
        authedGet,
        now,
      })
      if (!limits) continue
      if (limits.error) {
        throw new ProviderOperationFailureError({
          code: "invalid-response",
          retryable: true,
          message: limits.error,
        })
      }
      return { source: source.key, fetchedAt: limits.fetchedAt, meters: limits.meters }
    }
    throw new ProviderOperationFailureError({
      code: "capability-unsupported",
      retryable: false,
      message: `every quota source declined ${provider.providerId}`,
    })
  },
}

// ---- rate limits ------------------------------------------------------------------

export interface RateLimitReading {
  /** Meter name as the vendor spells it, e.g. `requests`, `tokens`, `input-tokens`. */
  name: string
  limit?: number
  remaining?: number
  /** Epoch ms when the window resets, when the vendor says. */
  resetAt?: number
}

export interface RateLimitsReadOutput {
  observedAt: number
  limits: RateLimitReading[]
}

const ROLES = new Set(["limit", "remaining", "reset"])

/** `6m0s`, `1.5s`, `20ms`, or a bare number of seconds, to milliseconds. */
export function durationToMs(value: string): number | undefined {
  const trimmed = value.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000
  const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 }
  let total = 0
  let matched = false
  for (const part of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    total += Number(part[1]) * units[part[2]]
    matched = true
  }
  return matched ? total : undefined
}

/** Every `*ratelimit*` header, grouped by meter name. */
export function parseRateLimitHeaders(headers: Headers, now: number): RateLimitReading[] {
  const byName = new Map<string, RateLimitReading>()
  headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase()
    const at = name.indexOf("ratelimit")
    if (at < 0) return
    const tokens = name
      .slice(at + "ratelimit".length)
      .split("-")
      .filter(Boolean)
    const role = tokens.find((token) => ROLES.has(token))
    if (!role) return
    const meter = tokens.filter((token) => token !== role).join("-") || "requests"
    const reading = byName.get(meter) ?? { name: meter }
    if (role === "reset") {
      const parsed = Date.parse(value)
      const ms = Number.isNaN(parsed) ? durationToMs(value) : undefined
      if (!Number.isNaN(parsed)) reading.resetAt = parsed
      else if (ms !== undefined) reading.resetAt = now + ms
    } else {
      const number = Number(value)
      if (!Number.isFinite(number)) return
      if (role === "limit") reading.limit = number
      else reading.remaining = number
    }
    byName.set(meter, reading)
  })
  return [...byName.values()]
}

export const rateLimitsReadHandler: ProviderOperationHandlerRegistration<
  Record<string, never>,
  RateLimitsReadOutput
> = {
  operationId: "rate-limits.read",
  providerMatch: { kind: "any" },
  support: "derived",
  async handler({ provider, signal }) {
    const response = await providerRequest(provider, { path: "models", signal })
    const observedAt = Date.now()
    return { observedAt, limits: parseRateLimitHeaders(response.headers, observedAt) }
  },
}

// ---- provider usage ---------------------------------------------------------------

export interface UsageWindowInput {
  /** Epoch ms, defaults to seven days ago. */
  since?: number
  /** Epoch ms, defaults to now. */
  until?: number
}

export interface UsageBucket {
  start: number
  end: number
  inputTokens: number
  outputTokens: number
  requests?: number
}

export interface UsageReadOutput {
  since: number
  until: number
  buckets: UsageBucket[]
  totals: { inputTokens: number; outputTokens: number; requests: number }
}

function windowOf(input: UsageWindowInput | undefined, now = Date.now()) {
  const until = input?.until ?? now
  const since = input?.since ?? until - 7 * DAY_MS
  if (since >= until) {
    throw new ProviderOperationFailureError({
      code: "schema",
      retryable: false,
      message: "usage window must start before it ends",
    })
  }
  return { since, until }
}

function totalsOf(buckets: UsageBucket[]): UsageReadOutput["totals"] {
  return buckets.reduce(
    (sum, bucket) => ({
      inputTokens: sum.inputTokens + bucket.inputTokens,
      outputTokens: sum.outputTokens + bucket.outputTokens,
      requests: sum.requests + (bucket.requests ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, requests: 0 }
  )
}

interface UsageEndpoint {
  providerId: string
  /** Absolute usage endpoint. Admin surfaces do not live under the inference base URL. */
  baseURL?: string
  path(window: { since: number; until: number }): string
  parse(json: unknown): UsageBucket[]
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function rows(json: unknown, key: string): Array<Record<string, unknown>> {
  const list = (json as Record<string, unknown> | undefined)?.[key]
  return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : []
}

/** OpenAI and Anthropic share the bucket-of-results shape, with different field names. */
function bucketed(
  json: unknown,
  fields: { start: string; end: string; input: string[]; output: string; requests?: string },
  timeScale: number
): UsageBucket[] {
  return rows(json, "data").map((bucket) => {
    const results = Array.isArray(bucket.results)
      ? (bucket.results as Array<Record<string, unknown>>)
      : []
    const sum = (keys: string[]) =>
      results.reduce((acc, row) => acc + keys.reduce((inner, key) => inner + num(row[key]), 0), 0)
    const at = (value: unknown) =>
      typeof value === "string" ? Date.parse(value) : num(value) * timeScale
    return {
      start: at(bucket[fields.start]),
      end: at(bucket[fields.end]),
      inputTokens: sum(fields.input),
      outputTokens: sum([fields.output]),
      ...(fields.requests ? { requests: sum([fields.requests]) } : {}),
    }
  })
}

const USAGE_ENDPOINTS: UsageEndpoint[] = [
  {
    providerId: "openai",
    baseURL: "https://api.openai.com/v1",
    path: ({ since, until }) =>
      `organization/usage/completions?start_time=${Math.floor(since / 1000)}&end_time=${Math.floor(until / 1000)}&bucket_width=1d&limit=31`,
    parse: (json) =>
      bucketed(
        json,
        {
          start: "start_time",
          end: "end_time",
          input: ["input_tokens"],
          output: "output_tokens",
          requests: "num_model_requests",
        },
        1000
      ),
  },
  {
    providerId: "anthropic",
    baseURL: "https://api.anthropic.com/v1",
    path: ({ since, until }) =>
      `organizations/usage_report/messages?starting_at=${new Date(since).toISOString()}&ending_at=${new Date(until).toISOString()}&bucket_width=1d&limit=31`,
    parse: (json) =>
      bucketed(
        json,
        {
          start: "starting_at",
          end: "ending_at",
          input: [
            "uncached_input_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
          ],
          output: "output_tokens",
        },
        1000
      ),
  },
  {
    providerId: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    path: () => "activity",
    parse: (json) => {
      const byDay = new Map<string, UsageBucket>()
      for (const row of rows(json, "data")) {
        const date = typeof row.date === "string" ? row.date : undefined
        if (!date) continue
        const start = Date.parse(date)
        if (Number.isNaN(start)) continue
        const bucket = byDay.get(date) ?? {
          start,
          end: start + DAY_MS,
          inputTokens: 0,
          outputTokens: 0,
          requests: 0,
        }
        bucket.inputTokens += num(row.prompt_tokens)
        bucket.outputTokens += num(row.completion_tokens)
        bucket.requests = (bucket.requests ?? 0) + num(row.requests)
        byDay.set(date, bucket)
      }
      return [...byDay.values()].sort((a, b) => a.start - b.start)
    },
  },
]

function usageHandler(
  endpoint: UsageEndpoint
): ProviderOperationHandlerRegistration<UsageWindowInput, UsageReadOutput> {
  return {
    operationId: "usage.provider.read",
    providerMatch: { kind: "provider", providerId: endpoint.providerId },
    support: "native",
    async handler({ provider, request, signal }) {
      const window = windowOf(request.input)
      const { json } = await providerRequest(provider, {
        path: endpoint.path(window),
        ...(endpoint.baseURL ? { baseURL: endpoint.baseURL } : {}),
        signal,
      })
      const buckets = endpoint
        .parse(json)
        .filter((bucket) => bucket.end > window.since && bucket.start < window.until)
      return { ...window, buckets, totals: totalsOf(buckets) }
    },
  }
}

// ---- local usage ------------------------------------------------------------------

export interface LocalUsageReadOutput {
  since: number
  until: number
  turns: number
  totals: { inputTokens: number; outputTokens: number; costUsd: number }
  byModel: ModelUsageRow[]
}

export const usageLocalReadHandler: ProviderOperationHandlerRegistration<
  UsageWindowInput,
  LocalUsageReadOutput
> = {
  operationId: "usage.local.read",
  providerMatch: { kind: "any" },
  support: "derived",
  async handler({ provider, request }) {
    const window = windowOf(request.input)
    const rowsInWindow = await getDb()
      .sessionUsage.where("providerId")
      .equals(provider.providerId)
      .and((row) => row.at >= window.since && row.at < window.until)
      .toArray()
    const byModel = aggregateByModel(rowsInWindow)
    return {
      ...window,
      turns: rowsInWindow.length,
      totals: byModel.reduce(
        (sum, row) => ({
          inputTokens: sum.inputTokens + row.inputTokens,
          outputTokens: sum.outputTokens + row.outputTokens,
          costUsd: sum.costUsd + row.costUsd,
        }),
        { inputTokens: 0, outputTokens: 0, costUsd: 0 }
      ),
      byModel,
    }
  },
}

export const ACCOUNT_HANDLERS: ProviderOperationHandlerRegistration[] = [
  balanceReadHandler,
  quotaReadHandler,
  rateLimitsReadHandler,
  ...USAGE_ENDPOINTS.map(usageHandler),
  usageLocalReadHandler,
] as ProviderOperationHandlerRegistration[]
