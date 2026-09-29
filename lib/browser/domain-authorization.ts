/**
 * "Is this URL's domain authorized to run in the cloud browser?"
 *
 * `routeEngine` has always taken a `domainAuthorized` flag and has never been
 * given one: both production callers passed a bare URL, so the
 * `tier === "public" && domainAuthorized === true` arm could not fire. That arm
 * is the only door to remote Chromium for a public site, so a user who granted
 * a domain in Settings got nothing for it.
 *
 * Two things make this awkward, and both are handled here rather than at the
 * call sites:
 *
 * 1. `routeEngine` is synchronous while grants live in Dexie. A snapshot keeps
 *    the read synchronous. `primeBrowserDomainGrants` reads it once AND starts
 *    a Dexie `liveQuery` subscription (ADR-0201), so a grant made or revoked in
 *    Settings takes effect on the very next tool call instead of after a
 *    plugin reload.
 * 2. Grants are stored per workspace, and there are two kinds of workspace id
 *    in play: the active project (what the settings card and the preview use)
 *    and the synthetic `external-service:*` ids that `connectBrowserSite`
 *    invents. A grant made through either route is a grant the user made, so
 *    the snapshot is the union and the lookup ignores which one it came from.
 */

import Dexie from "dexie"

import { listAllBrowserDomainGrants, normalizeBrowserGrantDomain } from "@/lib/db/browser-profiles"

/** domain -> the workspaces that granted it. */
let snapshot = new Map<string, Set<string>>()

/** Replace the warmed snapshot. Returns the domains it now holds. */
export function setBrowserDomainGrantSnapshot(
  grants: readonly { workspaceId: string; domain: string }[]
): string[] {
  const next = new Map<string, Set<string>>()
  for (const grant of grants) {
    const existing = next.get(grant.domain)
    if (existing) existing.add(grant.workspaceId)
    else next.set(grant.domain, new Set([grant.workspaceId]))
  }
  snapshot = next
  return [...next.keys()]
}

/** The live subscription, while one is running. */
let watcher: { unsubscribe(): void } | null = null

/**
 * Keep the snapshot in step with Dexie. Idempotent: a second call while the
 * subscription runs is a no-op. A read error clears the snapshot (authorize
 * nothing — the safe direction) and drops the subscription so the next
 * `primeBrowserDomainGrants` can start a fresh one.
 */
export function watchBrowserDomainGrants(): () => void {
  if (!watcher) {
    try {
      // `Dexie.liveQuery`, not a named import: dexie's CJS build makes
      // `liveQuery` non-enumerable under SWC's interop (see lib/db/outbound-jobs.ts).
      const subscription = Dexie.liveQuery(() => listAllBrowserDomainGrants()).subscribe({
        next: (grants) => {
          setBrowserDomainGrantSnapshot(grants)
        },
        error: () => {
          setBrowserDomainGrantSnapshot([])
          stopWatchingBrowserDomainGrants()
        },
      })
      watcher = subscription
    } catch {
      watcher = null
    }
  }
  return stopWatchingBrowserDomainGrants
}

/** Stop the live subscription (the snapshot keeps its last value). */
export function stopWatchingBrowserDomainGrants(): void {
  const current = watcher
  watcher = null
  current?.unsubscribe()
}

/**
 * Read every grant from Dexie into the snapshot and make sure the live
 * subscription is running. Safe to call repeatedly.
 */
export async function primeBrowserDomainGrants(): Promise<string[]> {
  let domains: string[]
  try {
    domains = setBrowserDomainGrantSnapshot(await listAllBrowserDomainGrants())
  } catch {
    // No database (headless / first paint): nothing is authorized, which is
    // the safe direction — an un-authorized public site is never sent to a
    // shared cloud browser.
    return setBrowserDomainGrantSnapshot([])
  }
  watchBrowserDomainGrants()
  return domains
}

/**
 * Whether `url`'s host is covered by a grant. A grant on `example.com` covers
 * its subdomains, matching how the runtime's own network policy reads it; an
 * unrelated host that merely *ends with* the same text (`notexample.com`) does
 * not.
 */
export function isBrowserDomainAuthorized(url: string): boolean {
  let host: string
  try {
    host = normalizeBrowserGrantDomain(url)
  } catch {
    // Not a public DNS host (localhost, an IP, a bare path): never authorized,
    // and never needs to be — those stay on the embedded engine.
    return false
  }
  for (const domain of snapshot.keys()) {
    if (host === domain || host.endsWith(`.${domain}`)) return true
  }
  return false
}

/** Test seam: drop the warmed snapshot. */
export function __resetBrowserDomainGrantsForTests(): void {
  stopWatchingBrowserDomainGrants()
  snapshot = new Map()
}
