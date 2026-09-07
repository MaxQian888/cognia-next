// Runner for user-defined custom limits sources. Each `CustomLimitsSource` is
// self-contained (its own baseUrl + token, no vault account), so it bypasses
// the account/preset resolution path entirely: we synthesize a descriptor + a
// source context and reuse the same `runDescriptor` engine the built-in catalog
// uses. Results carry a `custom:<id>` provider so they render as their own block
// in the limits panel.

import { getSubscriptionBreaker } from "@/lib/subscription/retry/breaker"

import { applyCoalescedResult, limitsBreakerKey, recordCoalescedThrow } from "../coalesce-record"
import { runDescriptor } from "../descriptor/engine"
import { CUSTOM_LIMITS_MIN_REFRESH_MS, isCustomSourceComplete } from "./store"

import type { SubscriptionBreaker } from "@/lib/subscription/retry/breaker"
import type {
  CustomLimitsSource,
  LimitsSourceContext,
  ProviderLimits,
  SourceDescriptor,
} from "@/types/subscription"

export interface CustomRunnerDeps {
  authedGet: (url: string, headers?: Record<string, string>) => Promise<string>
  now: () => number
  /** Injected credential ledger for tests. Defaults to the shared one. */
  breaker?: SubscriptionBreaker
  /** Deterministic jitter source for the recorded backoff. */
  random?: () => number
}

/**
 * Provider tag every custom source blocks under in the shared credential
 * ledger. A user-defined source has no vault account, so it is keyed by its own
 * id inside one synthetic provider namespace.
 */
const CUSTOM_BREAKER_PROVIDER = "custom"

interface CustomRunnerEntry {
  inflight: Promise<ProviderLimits | null> | null
  lastAttemptAt: number
  lastResult: ProviderLimits | null
  lastSuccessfulResult: ProviderLimits | null
}

const customEntries = new Map<string, CustomRunnerEntry>()

/** Provider id a custom source's snapshot is tagged with. */
export function customProviderId(id: string): string {
  return `custom:${id}`
}

/** Run one custom source, returning its snapshot or `null` (incomplete/no data). */
export async function runCustomLimitsSource(
  src: CustomLimitsSource,
  deps: CustomRunnerDeps
): Promise<ProviderLimits | null> {
  if (!isCustomSourceComplete(src)) return null

  const descriptor: SourceDescriptor = {
    id: customProviderId(src.id),
    match: {},
    request: src.request,
    extract: src.extract,
  }
  const ctx: LimitsSourceContext = {
    // The vault `provider` field is irrelevant for a self-contained source; we
    // pin a harmless value and identify the source by `accountId`/`accountLabel`.
    provider: "opencode",
    accountId: src.id,
    accountLabel: src.name,
    token: src.token,
    baseUrl: src.baseUrl,
    providerKey: src.id,
    authedGet: deps.authedGet,
    now: deps.now(),
  }
  return runDescriptor(descriptor, ctx)
}

async function runCustomLimitsSourceCoalesced(
  src: CustomLimitsSource,
  deps: CustomRunnerDeps
): Promise<ProviderLimits | null> {
  const entry = customEntries.get(src.id) ?? {
    inflight: null,
    lastAttemptAt: 0,
    lastResult: null,
    lastSuccessfulResult: null,
  }
  customEntries.set(src.id, entry)
  if (entry.inflight) return entry.inflight

  const breaker = deps.breaker ?? getSubscriptionBreaker()
  const currentTime = deps.now()

  // A provider-imposed block outranks the source's own refresh interval. A
  // custom source pointed at a relay with a tight bucket used to be re-polled
  // on its configured cadence no matter what the relay answered.
  const key = limitsBreakerKey(CUSTOM_BREAKER_PROVIDER, src.id)
  if (!breaker.shouldAttempt(key, currentTime).allowed) return entry.lastResult

  const interval = Math.max(CUSTOM_LIMITS_MIN_REFRESH_MS, src.refreshIntervalMs ?? 0)
  if (entry.lastAttemptAt > 0 && currentTime - entry.lastAttemptAt < interval) {
    return entry.lastResult
  }

  const recordOptions = {
    provider: CUSTOM_BREAKER_PROVIDER,
    accountId: src.id,
    now: deps.now,
    breaker,
    random: deps.random,
  }
  const request = (async () => {
    try {
      const result = await runCustomLimitsSource(src, deps)
      return applyCoalescedResult(entry, result, recordOptions)
    } catch (error) {
      recordCoalescedThrow(error, recordOptions)
      return entry.lastResult
    } finally {
      entry.lastAttemptAt = deps.now()
      entry.inflight = null
    }
  })()
  entry.inflight = request
  return request
}

/** Run every complete custom source concurrently, dropping the empty ones. */
export async function runCustomLimitsSources(
  sources: readonly CustomLimitsSource[],
  deps: CustomRunnerDeps
): Promise<ProviderLimits[]> {
  const results = await Promise.all(
    sources
      .filter((source) => source.enabled === true)
      .map((s) => runCustomLimitsSourceCoalesced(s, deps).catch(() => null))
  )
  return results.filter((r): r is ProviderLimits => r !== null)
}

/** Test-only: clear in-memory single-flight/throttle state. */
export function __resetCustomLimitsRunnerForTesting(): void {
  customEntries.clear()
}
