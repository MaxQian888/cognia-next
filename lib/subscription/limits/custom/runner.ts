// Runner for user-defined custom limits sources. Each `CustomLimitsSource` is
// self-contained (its own baseUrl + token, no vault account), so it bypasses
// the account/preset resolution path entirely: we synthesize a descriptor + a
// source context and reuse the same `runDescriptor` engine the built-in catalog
// uses. Results carry a `custom:<id>` provider so they render as their own block
// in the limits panel.

import { applyCoalescedResult } from "../coalesce-record"
import { runDescriptor } from "../descriptor/engine"
import { CUSTOM_LIMITS_MIN_REFRESH_MS, isCustomSourceComplete } from "./store"

import type {
  CustomLimitsSource,
  LimitsSourceContext,
  ProviderLimits,
  SourceDescriptor,
} from "@/types/subscription"

export interface CustomRunnerDeps {
  authedGet: (url: string, headers?: Record<string, string>) => Promise<string>
  now: () => number
}

const CUSTOM_QUERY_RATE_LIMIT_BACKOFF_MS = 15 * 60_000

interface CustomRunnerEntry {
  inflight: Promise<ProviderLimits | null> | null
  lastAttemptAt: number
  blockedUntil: number
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
    blockedUntil: 0,
    lastResult: null,
    lastSuccessfulResult: null,
  }
  customEntries.set(src.id, entry)
  if (entry.inflight) return entry.inflight

  const currentTime = deps.now()
  const interval = Math.max(CUSTOM_LIMITS_MIN_REFRESH_MS, src.refreshIntervalMs ?? 0)
  if (
    entry.lastAttemptAt > 0 &&
    (currentTime < entry.blockedUntil || currentTime - entry.lastAttemptAt < interval)
  ) {
    return entry.lastResult
  }

  const request = (async () => {
    try {
      const result = await runCustomLimitsSource(src, deps)
      return applyCoalescedResult(entry, result, deps.now, CUSTOM_QUERY_RATE_LIMIT_BACKOFF_MS)
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
