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
 * 1. `routeEngine` is synchronous while grants live in Dexie. A warmed snapshot
 *    keeps the read synchronous; `primeBrowserDomainGrants` refreshes it.
 * 2. Grants are stored per workspace, and there are two kinds of workspace id
 *    in play: the active project (what the settings card and the preview use)
 *    and the synthetic `external-service:*` ids that `connectBrowserSite`
 *    invents. A grant made through either route is a grant the user made, so
 *    the snapshot is the union and the lookup ignores which one it came from.
 */

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

/** Read every grant from Dexie into the snapshot. Safe to call repeatedly. */
export async function primeBrowserDomainGrants(): Promise<string[]> {
  try {
    return setBrowserDomainGrantSnapshot(await listAllBrowserDomainGrants())
  } catch {
    // No database (headless / first paint): nothing is authorized, which is
    // the safe direction — an un-authorized public site stays on the embedded
    // engine rather than being sent to a shared cloud browser.
    return setBrowserDomainGrantSnapshot([])
  }
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
  snapshot = new Map()
}
