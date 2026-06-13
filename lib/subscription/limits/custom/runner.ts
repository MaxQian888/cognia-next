// Runner for user-defined custom limits sources. Each `CustomLimitsSource` is
// self-contained (its own baseUrl + token, no vault account), so it bypasses
// the account/preset resolution path entirely: we synthesize a descriptor + a
// source context and reuse the same `runDescriptor` engine the built-in catalog
// uses. Results carry a `custom:<id>` provider so they render as their own block
// in the limits panel.

import { runDescriptor } from "../descriptor/engine"
import { isCustomSourceComplete } from "./store"

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

/** Run every complete custom source concurrently, dropping the empty ones. */
export async function runCustomLimitsSources(
  sources: readonly CustomLimitsSource[],
  deps: CustomRunnerDeps
): Promise<ProviderLimits[]> {
  const results = await Promise.all(
    sources.map((s) => runCustomLimitsSource(s, deps).catch(() => null))
  )
  return results.filter((r): r is ProviderLimits => r !== null)
}
