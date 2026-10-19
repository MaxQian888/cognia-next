import { getSearchCache } from "@cognia/web-search/search-cache"
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
