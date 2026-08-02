import type {
  ProviderBalanceSnapshot,
  ProviderBalanceSource,
  ProviderDiagnosticFailure,
  ProviderBalanceScriptSourceConfig,
} from "@cognia/provider-types"

import { findBalanceAdapter, BALANCE_ADAPTERS } from "@/lib/subscription/balance/registry"
import { authedRequest as defaultAuthedRequest } from "@/lib/subscription/core/transport"
import type { BalanceAdapter, BalanceQuery } from "@/types/subscription"
import type { ProviderLimitsRow, SubscriptionBalanceRow } from "@/types/subscription"

import { listProviderBalanceSnapshots, recordProviderBalanceSnapshot } from "./store"
import { runProviderBalanceScript as defaultRunProviderBalanceScript } from "./sandbox"

export interface ResolvedProviderBalanceSource extends ProviderBalanceSource {
  credentialFingerprint: string
  /** Ephemeral query material. It is never written to Dexie or companion projections. */
  query?: BalanceQuery
  scriptConfig?: ProviderBalanceScriptSourceConfig
}

interface ResolveBalanceSourceInput {
  providerId: string
  providerKey?: string
  baseUrl: string
  token?: string
  credentialId?: string
  accountId?: string
  label: string
  primary?: boolean
  enabled?: boolean
}

export function resolveProviderBalanceSource(
  input: ResolveBalanceSourceInput
): ResolvedProviderBalanceSource {
  const adapter = findBalanceAdapter({ providerKey: input.providerKey, baseUrl: input.baseUrl })
  const credentialIdentity = input.accountId ?? input.credentialId ?? "primary"
  const sourceId = `${input.providerId}:${credentialIdentity}:${adapter?.key ?? "unsupported"}`
  const builtIn = adapter ? BALANCE_ADAPTERS.includes(adapter) : false
  return {
    id: sourceId,
    providerId: input.providerId,
    accountId: input.accountId,
    credentialId: input.credentialId,
    kind: adapter ? (builtIn ? "official" : "plugin") : "unsupported",
    label: input.label,
    primary: input.primary ?? false,
    enabled: input.enabled ?? true,
    credentialFingerprint: `credential:${input.providerId}:${credentialIdentity}`,
    ...(adapter && input.token
      ? {
          query: {
            accountId: input.accountId ?? credentialIdentity,
            providerKey: input.providerKey ?? adapter.key,
            baseUrl: input.baseUrl,
            token: input.token,
          },
        }
      : {}),
  }
}

/** Select exactly one source. Separate credentials/accounts are never summed. */
export function selectPrimaryBalanceSource<T extends ProviderBalanceSource>(
  sources: T[],
  preferredId?: string
): T[] {
  const preferred = preferredId ? sources.find((source) => source.id === preferredId) : undefined
  const selected =
    preferred ??
    sources.find((source) => source.kind === "official" && source.accountId) ??
    sources.find((source) => source.kind === "official") ??
    sources.find((source) => source.enabled)
  return sources.map((source) => ({ ...source, primary: source.id === selected?.id }))
}

function retryAfterMs(headers: Array<{ name: string; value: string }>): number | undefined {
  const value = headers.find((header) => header.name.toLowerCase() === "retry-after")?.value
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

function responseFailure(
  status: number,
  headers: Array<{ name: string; value: string }>,
  parserError?: string
): ProviderDiagnosticFailure {
  if (status === 401) {
    return {
      code: "authentication",
      retryable: false,
      message: "Credential rejected",
      httpStatus: status,
    }
  }
  if (status === 403) {
    return {
      code: "permission",
      retryable: false,
      message: "Balance access denied",
      httpStatus: status,
    }
  }
  if (status === 429) {
    return {
      code: "rate-limited",
      retryable: true,
      message: "Balance source rate limited the request",
      httpStatus: status,
      retryAfterMs: retryAfterMs(headers),
    }
  }
  if (status >= 500) {
    return {
      code: "transport",
      retryable: true,
      message: `Provider error (HTTP ${status})`,
      httpStatus: status,
    }
  }
  if (status < 200 || status >= 300) {
    return {
      code: "invalid-response",
      retryable: false,
      message: `Balance request failed (HTTP ${status})`,
      httpStatus: status,
    }
  }
  return {
    code: "schema",
    retryable: false,
    message: parserError ?? "Balance response schema was not recognized",
  }
}

function adapterForSource(source: ResolvedProviderBalanceSource): BalanceAdapter | undefined {
  return source.query
    ? findBalanceAdapter({
        providerKey: source.query.providerKey,
        baseUrl: source.query.baseUrl,
      })
    : undefined
}

interface RefreshBalanceDependencies {
  authedRequest: typeof defaultAuthedRequest
  now: () => number
  randomUUID: () => string
  runBalanceScript: typeof defaultRunProviderBalanceScript
}

export async function refreshProviderBalanceSources(
  sources: ResolvedProviderBalanceSource[],
  dependencies: Partial<RefreshBalanceDependencies> = {}
): Promise<ProviderBalanceSnapshot[]> {
  const authedRequest = dependencies.authedRequest ?? defaultAuthedRequest
  const now = dependencies.now ?? Date.now
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID())
  const runBalanceScript = dependencies.runBalanceScript ?? defaultRunProviderBalanceScript
  return Promise.all(
    sources
      .filter((source) => source.enabled)
      .map(async (source) => {
        const fetchedAt = now()
        const previous = (
          await listProviderBalanceSnapshots({
            providerId: source.providerId,
            sourceId: source.id,
          })
        ).find((snapshot) => !snapshot.failure)
        const base: ProviderBalanceSnapshot = {
          id: randomUUID(),
          providerId: source.providerId,
          sourceId: source.id,
          accountId: source.accountId,
          credentialFingerprint: source.credentialFingerprint,
          amounts: previous?.amounts ?? [],
          available: previous?.available,
          fetchedAt,
          staleAt: previous?.fetchedAt ?? fetchedAt,
        }
        const adapter = adapterForSource(source)
        if (source.kind === "sandbox-script" && source.scriptConfig) {
          try {
            const result = await runBalanceScript(source.scriptConfig, {
              providerId: source.providerId,
              sourceId: source.id,
              endpoint: source.scriptConfig.sameOrigin,
              credentialRef: source.scriptConfig.credentialRef,
            })
            return recordProviderBalanceSnapshot({
              ...base,
              amounts: result.amounts,
              available: result.available,
              staleAt: fetchedAt + 30 * 60_000,
            })
          } catch (error) {
            return recordProviderBalanceSnapshot({
              ...base,
              failure: {
                code: /grant|private|userinfo|header|request limit|response exceeds/i.test(
                  error instanceof Error ? error.message : String(error)
                )
                  ? "script-policy"
                  : "schema",
                retryable: false,
                message: error instanceof Error ? error.message : String(error),
              },
            })
          }
        }
        if (!adapter || !source.query) {
          const snapshot = {
            ...base,
            failure: {
              code: "capability-unsupported" as const,
              retryable: false,
              message: "No verified balance adapter is available for this provider",
            },
          }
          return recordProviderBalanceSnapshot(snapshot)
        }

        try {
          const descriptor = adapter.request(source.query)
          const response = await authedRequest({
            url: descriptor.url,
            method: "GET",
            headers: descriptor.headers,
          })
          const parsed = adapter.parse(response.status, response.body, source.query)
          if (parsed.error) {
            return recordProviderBalanceSnapshot({
              ...base,
              failure: responseFailure(response.status, response.headers, parsed.error),
            })
          }
          const unit = parsed.currency ?? parsed.unit ?? "credits"
          return recordProviderBalanceSnapshot({
            ...base,
            amounts: [
              {
                unit,
                remaining: parsed.remaining,
                total: parsed.total,
                used: parsed.used,
              },
            ],
            available: parsed.remaining === undefined ? undefined : parsed.remaining > 0,
            staleAt: fetchedAt + 30 * 60 * 1_000,
          })
        } catch (error) {
          return recordProviderBalanceSnapshot({
            ...base,
            failure: {
              code: /abort|cancel/i.test(error instanceof Error ? error.message : String(error))
                ? "aborted"
                : "transport",
              retryable: true,
              message: error instanceof Error ? error.message : String(error),
            },
          })
        }
      })
  )
}

export function resolveSandboxBalanceSource(
  config: ProviderBalanceScriptSourceConfig
): ResolvedProviderBalanceSource {
  return {
    id: config.id,
    providerId: config.providerId,
    kind: "sandbox-script",
    label: config.label,
    primary: false,
    enabled: config.enabled,
    credentialFingerprint: `credential:${config.providerId}:sandbox:${config.credentialRef}`,
    scriptConfig: config,
  }
}

export function projectLegacyProviderBalanceRows(input: {
  providerId: string
  balances: SubscriptionBalanceRow[]
  limits: ProviderLimitsRow[]
}): { sources: ResolvedProviderBalanceSource[]; snapshots: ProviderBalanceSnapshot[] } {
  const sources = new Map<string, ResolvedProviderBalanceSource>()
  const snapshots: ProviderBalanceSnapshot[] = []
  for (const row of input.balances) {
    if (row.providerKey !== input.providerId) continue
    const sourceId = `${input.providerId}:account:${row.accountId}:legacy-balance`
    sources.set(sourceId, {
      id: sourceId,
      providerId: input.providerId,
      accountId: row.accountId,
      kind: "official",
      label: row.accountId,
      primary: false,
      enabled: true,
      credentialFingerprint: `credential:${input.providerId}:account:${row.accountId}`,
    })
    const unit = row.currency ?? row.unit ?? "credits"
    snapshots.push({
      id: `legacy-balance:${row.localId ?? `${row.accountId}:${row.fetchedAt}`}`,
      providerId: input.providerId,
      sourceId,
      accountId: row.accountId,
      credentialFingerprint: `credential:${input.providerId}:account:${row.accountId}`,
      amounts: [{ unit, remaining: row.remaining, total: row.total, used: row.used }],
      available: row.remaining === undefined ? undefined : row.remaining > 0,
      fetchedAt: row.fetchedAt,
      staleAt: row.fetchedAt + 30 * 60_000,
      ...(row.error
        ? { failure: { code: "transport" as const, retryable: true, message: row.error } }
        : {}),
    })
  }
  for (const row of input.limits) {
    if (row.provider !== input.providerId || !row.accountId) continue
    const sourceId = `${input.providerId}:account:${row.accountId}:legacy-limits`
    sources.set(sourceId, {
      id: sourceId,
      providerId: input.providerId,
      accountId: row.accountId,
      kind: "official",
      label: row.accountLabel ?? row.accountId,
      primary: false,
      enabled: true,
      credentialFingerprint: `credential:${input.providerId}:account:${row.accountId}`,
    })
    const amounts = row.meters.flatMap((meter) => {
      if (meter.kind === "balance") {
        return [
          {
            unit: meter.currency ?? meter.unit ?? "credits",
            remaining: meter.remaining,
            total: meter.total,
            used: meter.used,
          },
        ]
      }
      return [
        {
          unit: meter.unit ?? meter.id,
          remaining: meter.usedPct === null ? undefined : Math.max(0, 100 - meter.usedPct),
          total: 100,
          used: meter.usedPct ?? undefined,
        },
      ]
    })
    snapshots.push({
      id: `legacy-limits:${row.localId ?? `${row.accountId}:${row.fetchedAt}`}`,
      providerId: input.providerId,
      sourceId,
      accountId: row.accountId,
      credentialFingerprint: `credential:${input.providerId}:account:${row.accountId}`,
      amounts,
      available: amounts.some((amount) => (amount.remaining ?? 0) > 0),
      fetchedAt: row.fetchedAt,
      staleAt: row.fetchedAt + 30 * 60_000,
      ...(row.error
        ? { failure: { code: "transport" as const, retryable: true, message: row.error } }
        : {}),
    })
  }
  snapshots.sort((left, right) => right.fetchedAt - left.fetchedAt)
  return { sources: [...sources.values()], snapshots }
}

export function crossedLowBalanceThreshold(input: {
  previous?: number
  current?: number
  threshold: number
}): boolean {
  return (
    input.current !== undefined &&
    input.current <= input.threshold &&
    (input.previous === undefined || input.previous > input.threshold)
  )
}
