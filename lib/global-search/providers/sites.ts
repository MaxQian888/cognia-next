/**
 * Cognia Sites (ADR-0084): every deployable project, opening the `/sites`
 * console at that Site.
 *
 * Identity only, like `./devices`. A provider runs on every keystroke, so this
 * reads three index-backed lists — the Site rows, the active deployments, and
 * the custom-domain resources — and never `siteVersions`, which is the largest
 * Sites table and would make a bare integer needle match every Site's build
 * history.
 *
 * A production hostname is the thing people actually remember about a site, so
 * it is searchable alongside the Cognia name and the worker name.
 */

import { GlobeIcon } from "lucide-react"

import { listActiveSiteDeployments, listSiteProjects, listSiteResources } from "@/lib/db/sites"
import type { SiteLifecycle } from "@/types/sites"

import { createListProvider } from "./list-provider"

export const SITES_PROVIDER_ID = "builtin.sites"

/** The identity subset the palette needs. Never the full console row. */
export interface SiteSearchRow {
  id: string
  label: string
  workerName: string
  lifecycle: SiteLifecycle
  /** The live URL, when one exists — the disambiguating detail. */
  productionUrl?: string
  hostnames: string[]
  timestamp?: number
}

export interface SitesProviderDeps {
  listSites: typeof listSiteProjects
  listActiveDeployments: typeof listActiveSiteDeployments
  listResources: typeof listSiteResources
}

const defaultDeps: SitesProviderDeps = {
  listSites: listSiteProjects,
  listActiveDeployments: listActiveSiteDeployments,
  listResources: listSiteResources,
}

function hostnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

export async function loadSiteSearchRows(
  deps: SitesProviderDeps = defaultDeps
): Promise<SiteSearchRow[]> {
  const [sites, deployments] = await Promise.all([
    deps.listSites().catch(() => []),
    deps.listActiveDeployments().catch(() => []),
  ])
  // Only for Sites that exist; a profile with none pays nothing.
  const domainsBySite = new Map<string, string[]>()
  await Promise.all(
    sites.map(async (site) => {
      const resources = await deps.listResources(site.id).catch(() => [])
      domainsBySite.set(
        site.id,
        resources
          .filter((row) => row.kind === "custom-domain" && row.status === "active")
          .flatMap((row) => (row.displayName ? [row.displayName] : []))
      )
    })
  )

  return (
    sites
      // A purged Site with metadata still around is not a destination.
      .filter((site) => site.lifecycle !== "deleted")
      .map((site) => {
        const deployment = deployments
          .filter((row) => row.siteId === site.id)
          .reduce<(typeof deployments)[number] | undefined>(
            (newest, row) => (!newest || row.updatedAt > newest.updatedAt ? row : newest),
            undefined
          )
        const productionHost = hostnameOf(deployment?.productionUrl)
        return {
          id: site.id,
          label: site.name,
          workerName: site.providerConfig.workerName,
          lifecycle: site.lifecycle,
          ...(deployment?.productionUrl ? { productionUrl: deployment.productionUrl } : {}),
          hostnames: [
            ...new Set([
              ...(productionHost ? [productionHost] : []),
              ...(domainsBySite.get(site.id) ?? []),
            ]),
          ],
          timestamp: site.updatedAt,
        }
      })
  )
}

export function createSitesProvider(deps: SitesProviderDeps = defaultDeps) {
  return createListProvider<SiteSearchRow>({
    id: SITES_PROVIDER_ID,
    kind: "site",
    load: () => loadSiteSearchRows(deps),
    getTitle: (row) => row.label,
    getSecondary: (row) => row.productionUrl ?? row.workerName,
    // The worker name and every attached hostname: what someone types when
    // they remember the site by its address rather than by what they called it.
    getKeywords: (row) => [row.workerName, ...row.hostnames],
    getTimestamp: (row) => row.timestamp,
    toItem: ({ row, match }, ctx) => ({
      id: `site:${row.id}`,
      kind: "site" as const,
      title: row.label,
      titlePositions: match.positions,
      subtitle: row.productionUrl ?? row.workerName,
      meta: ctx.t(`sites.lifecycle.${row.lifecycle}`),
      icon: { lucide: GlobeIcon },
      score: match.score,
      timestamp: row.timestamp,
      action: { type: "navigate", href: `/sites?site=${encodeURIComponent(row.id)}` },
    }),
  })
}

export const sitesProvider = createSitesProvider()
