/**
 * Account surfaces in the contract shapes: `balance.read`, `quota.read`,
 * `rate-limits.read`, `usage.provider.read` and `usage.local.read`.
 *
 * Balance and quota delegate to the subscription registries the settings
 * screens already use (`findBalanceAdapter`, `resolveLimitsSources`), so a
 * vendor is added there once and both the UI and this executor see it.
 * Rate limits are derived from the headers of a cheap authenticated GET.
 * Provider usage is bound per vendor to its documented usage endpoint, and
 * local usage reads the Dexie `sessionUsage` ledger this app writes.
 */

import type { z } from "zod"
import type {
  balanceReadInput,
  balanceReadOutput,
  quotaReadInput,
  quotaReadOutput,
  rateLimitsReadInput,
  rateLimitsReadOutput,
  usageLocalReadInput,
  usageLocalReadOutput,
  usageProviderReadInput,
  usageProviderReadOutput,
} from "@cognia/provider-types"
import type { BalanceQuery, BalanceSnapshot, LimitsMeter, ProviderId } from "@/types/subscription"
import { getDb } from "@/lib/db/schema"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { failureForStatus } from "@/lib/provider-diagnostics/probe"
import { findBalanceAdapter } from "@/lib/subscription/balance/registry"
import { resolveLimitsSources } from "@/lib/subscription/limits/registry"
import { aggregateByModel } from "@/lib/usage/session-analytics"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { ProviderOperationFailureError } from "../failure"
import type { ProviderOperationHandlerRegistration } from "../registry"
import { providerRequest } from "./http"

export type BalanceReadInput = z.infer<typeof balanceReadInput>
export type QuotaReadInput = z.infer<typeof quotaReadInput>
export type RateLimitsReadInput = z.infer<typeof rateLimitsReadInput>
export type RateLimitsReadOutput = z.infer<typeof rateLimitsReadOutput>
export type UsageProviderReadInput = z.infer<typeof usageProviderReadInput>
export type UsageProviderReadOutput = z.infer<typeof usageProviderReadOutput>
export type UsageLocalReadInput = z.infer<typeof usageLocalReadInput>
export type UsageLocalReadOutput = z.infer<typeof usageLocalReadOutput>

/** The contract balance plus the adapter's full snapshot for callers that want it. */
export interface BalanceReadOutput extends z.infer<typeof balanceReadOutput> {
  snapshot: BalanceSnapshot
}

/** The contract quota plus every meter the source reported. */
export interface QuotaReadOutput extends z.infer<typeof quotaReadOutput> {
  source: string
  meters: LimitsMeter[]
}

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

/** The contract's three balance kinds from an adapter snapshot. */
export function balanceKindOf(snapshot: BalanceSnapshot): BalanceReadOutput["kind"] {
  if (snapshot.kind === "credit") return "credits"
  if (snapshot.kind === "usage") return "postpaid"
  return "prepaid"
}

export const balanceReadHandler: ProviderOperationHandlerRegistration<
  BalanceReadInput,
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
    const snapshot = adapter.parse(response.status, body, query)
    if (snapshot.error) {
      throw new ProviderOperationFailureError({
        code: "invalid-response",
        retryable: true,
        message: snapshot.error,
      })
    }
    const amount = snapshot.remaining ?? snapshot.total ?? snapshot.used
    if (amount === undefined) {
      throw new ProviderOperationFailureError({
        code: "invalid-response",
        retryable: false,
        message: `${adapter.key} reported no amount`,
      })
    }
    return {
      amount,
      currency: snapshot.currency ?? snapshot.unit ?? "USD",
      kind: balanceKindOf(snapshot),
      capturedAt: snapshot.fetchedAt,
      snapshot,
    }
  },
}

// ---- quota ------------------------------------------------------------------------

/** The contract quota from the meter that best describes the account. */
export function quotaOf(
  meters: LimitsMeter[]
): Omit<QuotaReadOutput, "capturedAt" | "source" | "meters"> {
  const primary = meters.find((meter) => meter.kind === "window") ?? meters[0]
  if (!primary) {
    throw new ProviderOperationFailureError({
      code: "invalid-response",
      retryable: false,
      message: "the quota source reported no meters",
    })
  }
  if (primary.used !== undefined || primary.total !== undefined) {
    return {
      used: primary.used ?? 0,
      ...(primary.total !== undefined ? { limit: primary.total } : {}),
      unit: primary.unit ?? "units",
      ...(primary.resetAt ? { resetsAt: primary.resetAt } : {}),
    }
  }
  return {
    used: primary.usedPct ?? 0,
    limit: 100,
    unit: "percent",
    ...(primary.resetAt ? { resetsAt: primary.resetAt } : {}),
  }
}

export const quotaReadHandler: ProviderOperationHandlerRegistration<
  QuotaReadInput,
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
      return {
        ...quotaOf(limits.meters),
        capturedAt: limits.fetchedAt,
        source: source.key,
        meters: limits.meters,
      }
    }
    throw new ProviderOperationFailureError({
      code: "capability-unsupported",
      retryable: false,
      message: `every quota source declined ${provider.providerId}`,
    })
  },
}

// ---- rate limits ------------------------------------------------------------------

export type RateLimitReading = RateLimitsReadOutput["limits"][number]

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
      if (!Number.isNaN(parsed)) reading.resetsAt = parsed
      else if (ms !== undefined) reading.resetsAt = now + ms
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
  RateLimitsReadInput,
  RateLimitsReadOutput
> = {
  operationId: "rate-limits.read",
  providerMatch: { kind: "any" },
  support: "derived",
  async handler({ provider, signal }) {
    const response = await providerRequest(provider, { path: "models", signal })
    const capturedAt = Date.now()
    return { capturedAt, limits: parseRateLimitHeaders(response.headers, capturedAt) }
  },
}

// ---- provider usage ---------------------------------------------------------------

type UsageRow = UsageProviderReadOutput["rows"][number]

function windowOf(input: { from?: number; to?: number } | undefined, now = Date.now()) {
  const to = input?.to ?? now
  const from = input?.from ?? to - 7 * DAY_MS
  if (from >= to) {
    throw new ProviderOperationFailureError({
      code: "schema",
      retryable: false,
      message: "usage window must start before it ends",
    })
  }
  return { from, to }
}

/** `YYYY-MM-DD` (UTC) of an instant. */
export function dayOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}

interface UsageEndpoint {
  providerId: string
  /** Absolute usage endpoint. Admin surfaces do not live under the inference base URL. */
  baseURL?: string
  path(window: { from: number; to: number }): string
  parse(json: unknown): Array<UsageRow & { start: number }>
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
  fields: { start: string; input: string[]; output: string },
  timeScale: number
): Array<UsageRow & { start: number }> {
  return rows(json, "data").map((bucket) => {
    const results = Array.isArray(bucket.results)
      ? (bucket.results as Array<Record<string, unknown>>)
      : []
    const sum = (keys: string[]) =>
      results.reduce((acc, row) => acc + keys.reduce((inner, key) => inner + num(row[key]), 0), 0)
    const raw = bucket[fields.start]
    const start = typeof raw === "string" ? Date.parse(raw) : num(raw) * timeScale
    return {
      start,
      day: dayOf(start),
      inputTokens: sum(fields.input),
      outputTokens: sum([fields.output]),
    }
  })
}

const USAGE_ENDPOINTS: UsageEndpoint[] = [
  {
    providerId: "openai",
    baseURL: "https://api.openai.com/v1",
    path: ({ from, to }) =>
      `organization/usage/completions?start_time=${Math.floor(from / 1000)}&end_time=${Math.floor(to / 1000)}&bucket_width=1d&limit=31`,
    parse: (json) =>
      bucketed(
        json,
        { start: "start_time", input: ["input_tokens"], output: "output_tokens" },
        1000
      ),
  },
  {
    providerId: "anthropic",
    baseURL: "https://api.anthropic.com/v1",
    path: ({ from, to }) =>
      `organizations/usage_report/messages?starting_at=${new Date(from).toISOString()}&ending_at=${new Date(to).toISOString()}&bucket_width=1d&limit=31`,
    parse: (json) =>
      bucketed(
        json,
        {
          start: "starting_at",
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
      const parsed: Array<UsageRow & { start: number }> = []
      for (const row of rows(json, "data")) {
        const date = typeof row.date === "string" ? row.date : ""
        const start = Date.parse(date)
        if (Number.isNaN(start)) continue
        parsed.push({
          start,
          day: dayOf(start),
          ...(typeof row.model === "string" ? { model: row.model } : {}),
          inputTokens: num(row.prompt_tokens),
          outputTokens: num(row.completion_tokens),
          costUsd: num(row.usage),
        })
      }
      return parsed.sort((a, b) => a.start - b.start)
    },
  },
]

function usageHandler(
  endpoint: UsageEndpoint
): ProviderOperationHandlerRegistration<UsageProviderReadInput, UsageProviderReadOutput> {
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
      const usageRows = endpoint
        .parse(json)
        .filter((row) => row.start + DAY_MS > window.from && row.start < window.to)
        .map(({ start: _start, ...row }) => row)
      return { rows: usageRows, capturedAt: Date.now() }
    },
  }
}

// ---- local usage ------------------------------------------------------------------

export const usageLocalReadHandler: ProviderOperationHandlerRegistration<
  UsageLocalReadInput,
  UsageLocalReadOutput
> = {
  operationId: "usage.local.read",
  providerMatch: { kind: "any" },
  support: "derived",
  async handler({ provider, request }) {
    const window = windowOf(request.input)
    const providerId = request.input?.providerId ?? provider.providerId
    const ledger = await getDb()
      .sessionUsage.where("providerId")
      .equals(providerId)
      // IMPORTED rows are excluded (ADR-0165). Since the external usage index
      // shipped, `sessionUsage` also holds turns another coding agent paid
      // for, stamped with the provider ITS transcript named. This operation is
      // documented as "what this install spent", and it is what the CLI's
      // `provider usage` prints, so blending in another tool's bill would
      // silently inflate the one number a person checks against their invoice.
      .and((row) => row.at >= window.from && row.at < window.to && row.imported !== true)
      .toArray()
    // Every row carries the provider that served it, so attribution is exact.
    return {
      rows: aggregateByModel(ledger).map((row) => ({
        model: row.model,
        providerId,
        attribution: "exact" as const,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costUsd: row.costUsd,
      })),
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
