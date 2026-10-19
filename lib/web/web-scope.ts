import type { AppSettings } from "@cognia/agent-config-types"
import { getSearchCache, opaqueDigest } from "@cognia/web-search/search-cache"
import { readerPolicyFromSettings } from "@/lib/web/reader/reader-settings"
import {
  getRuntimeTargetScopeKey,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { getFetchCache } from "./fetch-cache"

let identity = getRuntimeTargetScopeKey()
let generation = 0

function scopeKey(): string {
  const owner = identity === "null" ? "local" : identity
  return generation === 0 ? owner : `${owner}:${generation}`
}

/** Account, selected execution host and activation generation for this runtime. */
export function currentWebScope(): string {
  return scopeKey()
}

/**
 * Opaque revision of every setting that authorizes a web operation: the
 * master switch, private-host permission, the Reader policy, and each search
 * provider's enablement, endpoint, grant, engine, model and credentials
 * (digested, never stored raw). Two equal revisions authorize the same
 * recipients with the same keys.
 */
export function webAuthorityRevision(settings: AppSettings | null | undefined): string {
  const providers = Object.values(settings?.searchProviders ?? {})
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) =>
      [
        p.providerId,
        p.enabled ? 1 : 0,
        p.baseUrl ?? "",
        p.allowPrivateEndpoint ? 1 : 0,
        p.engine ?? "",
        p.model ?? "",
        opaqueDigest([p.apiKey ?? "", ...(p.apiKeys ?? []), p.cx ?? ""].join("\u0000")),
      ].join(":")
    )
    .sort()
    .join(";")
  return [
    settings?.webTools?.enabled === false ? "off" : "on",
    settings?.webTools?.allowPrivateHosts === true ? "private" : "public",
    readerPolicyFromSettings(settings ?? undefined).revision,
    providers,
  ].join("|")
}

/** Invalidate departing authority, including a lock or a switch back to the same account. */
export function onWebScopeChange(): void {
  const nextIdentity = getRuntimeTargetScopeKey()
  if (nextIdentity === identity) return
  const oldScope = scopeKey()
  identity = nextIdentity
  generation += 1
  getFetchCache().clearScope(oldScope)
  getSearchCache().clear()
}

// Account activation, lock and host switches already publish at this seam.
// The subscription lives as long as the in-memory web caches it protects.
subscribeRuntimeTargetContext(onWebScopeChange)
