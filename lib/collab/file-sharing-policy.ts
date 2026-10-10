// The org's file-sharing policy (ADR-0222 §6.4), read from the collaboration
// plane and cached by revision.
//
// The plane is authoritative; this cache only saves a round trip per share
// dialog. It is keyed by endpoint, org and account, so switching any of them
// can never serve another tenant's policy, and it is refreshed whenever the
// server reports a newer revision than the one held (the file-share
// authorization answer carries it), so a tightened policy is seen on the very
// next share rather than after some expiry.

import type { CollabFileSharingPolicy, CollabFileSharingSettings } from "./client"
import type { CurrentCollabContext } from "./runtime-client"

type PolicyContext = Pick<CurrentCollabContext, "orgId" | "localAccountId"> & {
  client: Pick<
    CurrentCollabContext["client"],
    "baseUrl" | "getFileSharingPolicy" | "putFileSharingPolicy"
  >
}

const cache = new Map<string, CollabFileSharingPolicy>()

function cacheKey(context: PolicyContext): string {
  return `${context.client.baseUrl}\n${context.localAccountId}\n${context.orgId}`
}

/**
 * The org's policy. Served from the cache unless it is older than
 * `minRevision`, or `refresh` is set.
 */
export async function getOrgFileSharingPolicy(
  context: PolicyContext,
  options: { minRevision?: number; refresh?: boolean } = {}
): Promise<CollabFileSharingPolicy> {
  const key = cacheKey(context)
  const cached = cache.get(key)
  if (cached && !options.refresh && cached.revision >= (options.minRevision ?? 0)) {
    return cached
  }
  const fresh = await context.client.getFileSharingPolicy(context.orgId)
  cache.set(key, fresh)
  return fresh
}

/**
 * Save the org's policy over `baseRevision`. On success the cache holds the
 * saved revision; on a conflict the caller gets the error (carrying the
 * current policy) and the cache is dropped so the next read is fresh.
 */
export async function saveOrgFileSharingPolicy(
  context: PolicyContext,
  settings: CollabFileSharingSettings,
  baseRevision: number
): Promise<CollabFileSharingPolicy> {
  const key = cacheKey(context)
  try {
    const saved = await context.client.putFileSharingPolicy(context.orgId, {
      ...settings,
      baseRevision,
    })
    cache.set(key, saved)
    return saved
  } catch (error) {
    cache.delete(key)
    throw error
  }
}

/**
 * Drop every cached policy. Entries are keyed by endpoint, account and org,
 * so an account switch never reads another's; tests use this to start clean.
 */
export function forgetOrgFileSharingPolicies(): void {
  cache.clear()
}
