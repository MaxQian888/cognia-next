"use client"

/**
 * The capabilities answer for the current org (and workspace), live.
 *
 * # Presentation only
 *
 * What this returns decides which controls are offered and which reason is
 * shown. Every write is still decided by the server on its own request; see
 * `lib/collab/capabilities.ts`.
 *
 * # Scope is the cache key, and a late answer is discarded
 *
 * The answer belongs to one endpoint, profile, org, person and workspace. An
 * org switch while a request is in flight must not paint the old org's answer
 * into the new org's view, so every result is applied only if the scope it was
 * asked for is still the current one, and the cache is keyed by the full scope.
 *
 * # In memory only
 *
 * Nothing is written to Dexie. A persisted copy would outlive a revocation on
 * an offline device and is exactly the "cached authorization" the plan rules
 * out. Components mounted together share one request through `inflight`.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { CollabError } from "@/lib/collab/client"
import {
  fetchOrgCapabilities,
  type OrgCapabilities,
  type OrgCapabilitiesResult,
} from "@/lib/collab/capabilities"
import { resolveCurrentCollabContext, type CurrentCollabContext } from "@/lib/collab/runtime-client"
import { subscribeCollabScopeChanged } from "@/lib/collab/scope-events"

/** Reuse an answer this young instead of asking again. */
export const ORG_CAPABILITIES_FRESH_MS = 30_000
/** Re-ask on this interval while something is mounted. */
export const ORG_CAPABILITIES_REFRESH_MS = 60_000

export type OrgCapabilitiesView =
  | { status: "loading" }
  | { status: "unavailable"; reason: "not-configured" | "not-signed-in" }
  | { status: "unsupported" }
  | { status: "hidden" }
  | { status: "error"; message: string }
  | { status: "ready"; capabilities: OrgCapabilities }

export interface UseOrgCapabilitiesDeps {
  resolveContext?: () => Promise<CurrentCollabContext | null>
  fetch?: typeof fetchOrgCapabilities
  now?: () => number
  refreshIntervalMs?: number
}

interface CacheEntry {
  at: number
  result: OrgCapabilitiesResult
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<OrgCapabilitiesResult>>()

/** Test seam: forget every cached answer. */
export function __resetOrgCapabilitiesCacheForTesting(): void {
  cache.clear()
  inflight.clear()
}

function scopeKey(context: CurrentCollabContext, workspaceId: string | null): string {
  return [
    context.client.baseUrl,
    context.localAccountId,
    context.orgId,
    context.userId,
    workspaceId ?? "",
  ].join("|")
}

function viewOf(result: OrgCapabilitiesResult): OrgCapabilitiesView {
  return result.status === "ready"
    ? { status: "ready", capabilities: result.capabilities }
    : { status: result.status }
}

function failureView(cause: unknown): OrgCapabilitiesView {
  if (cause instanceof CollabError && cause.status === 401) {
    return { status: "unavailable", reason: "not-signed-in" }
  }
  return { status: "error", message: cause instanceof Error ? cause.message : String(cause) }
}

export function useOrgCapabilities(
  workspaceId: string | null | undefined,
  deps: UseOrgCapabilitiesDeps = {}
): OrgCapabilitiesView & { refresh: () => void } {
  const [view, setView] = useState<OrgCapabilitiesView>({ status: "loading" })
  const [scopeVersion, setScopeVersion] = useState(0)
  const [tick, setTick] = useState(0)
  const depsRef = useRef(deps)
  useEffect(() => {
    depsRef.current = deps
  })
  /** Bumped per load, so only the newest load may write the view. */
  const generation = useRef(0)
  const lastTick = useRef(0)

  const refresh = useCallback(() => setTick((value) => value + 1), [])

  useEffect(() => subscribeCollabScopeChanged(() => setScopeVersion((value) => value + 1)), [])

  useEffect(() => {
    const interval = depsRef.current.refreshIntervalMs ?? ORG_CAPABILITIES_REFRESH_MS
    const timer = setInterval(refresh, interval)
    const onFocus = () => refresh()
    window.addEventListener("focus", onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener("focus", onFocus)
    }
  }, [refresh])

  useEffect(() => {
    const current = ++generation.current
    const forced = tick !== lastTick.current
    lastTick.current = tick
    const workspace = workspaceId ?? null
    const d = depsRef.current
    const now = d.now ?? Date.now

    const apply = (next: OrgCapabilitiesView) => {
      if (generation.current === current) setView(next)
    }

    void (async () => {
      let context: CurrentCollabContext | null
      try {
        context = await (d.resolveContext ?? resolveCurrentCollabContext)()
      } catch (cause) {
        apply(failureView(cause))
        return
      }
      if (!context) {
        apply({ status: "unavailable", reason: "not-configured" })
        return
      }
      const key = scopeKey(context, workspace)
      const cached = cache.get(key)
      if (cached) {
        // Show what is known at once; only skip the request while it is fresh.
        apply(viewOf(cached.result))
        if (!forced && now() - cached.at < ORG_CAPABILITIES_FRESH_MS) return
      }
      let pending = inflight.get(key)
      if (!pending) {
        pending = (d.fetch ?? fetchOrgCapabilities)(context.client, {
          orgId: context.orgId,
          workspaceId: workspace,
        })
        inflight.set(key, pending)
        void pending.then(
          () => inflight.delete(key),
          () => inflight.delete(key)
        )
      }
      try {
        const result = await pending
        cache.set(key, { at: now(), result })
        apply(viewOf(result))
      } catch (cause) {
        // A refresh that fails keeps a cached answer on screen rather than
        // replacing it with an error; the next tick tries again.
        if (!cached) apply(failureView(cause))
      }
    })()

    // No abort on cleanup: the request may be shared with other subscribers.
    // A superseded load's answer still fills the cache and is dropped by `apply`.
  }, [workspaceId, scopeVersion, tick])

  return { ...view, refresh }
}
