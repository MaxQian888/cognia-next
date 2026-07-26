/**
 * Absolute-URL resolution for the marketing site (ADR-0092 §2).
 *
 * canonical tags, hreflang alternates, OpenGraph images and the sitemap all need
 * an origin, and a static export has no request to read one from — it has to be
 * baked in at build time.
 *
 * Resolution order mirrors `docs/lib/site.ts` so the two sites behave the same:
 *   1. `NEXT_PUBLIC_WEB_SITE_URL` — the real apex domain, set by the deploy
 *      workflow from the `WEB_SITE_URL` repo variable.
 *   2. `CF_PAGES_URL` — injected by Cloudflare Pages, so preview deployments get
 *      correct absolute URLs for free.
 *   3. the dev origin, which keeps `pnpm --filter web dev` self-consistent.
 *
 * The docs origin is resolved separately because the two sites live on
 * different hostnames: the website takes the apex, docs takes `docs.`.
 */

export const DEV_SITE_URL = "http://localhost:3002"
export const DEV_DOCS_URL = "http://localhost:3001"

export const SITE_NAME = "Cognia"
export const REPO_OWNER = "MaxQian888"
export const REPO_NAME = "cognia-next"
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`
export const LICENSE_URL = `${REPO_URL}/blob/master/LICENSE`
export const RELEASES_URL = `${REPO_URL}/releases`
export const SECURITY_URL = `${REPO_URL}/blob/master/SECURITY.md`
export const CONTRIBUTING_URL = `${REPO_URL}/blob/master/CONTRIBUTING.md`
export const LICENSE_SPDX = "AGPL-3.0-or-later"

type SiteEnv = {
  NEXT_PUBLIC_WEB_SITE_URL?: string
  NEXT_PUBLIC_DOCS_SITE_URL?: string
  CF_PAGES_URL?: string
}

/** Strip trailing slashes so callers can always concatenate `/`-prefixed paths. */
function normalize(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

function toOrigin(candidate: string | undefined, fallback: string): string {
  const raw = candidate?.trim()
  if (!raw) return fallback

  const withProtocol = /^https?:\/\//.test(raw) ? raw : `https://${raw}`
  try {
    // Reject values that are not URLs at all rather than emitting a sitemap
    // full of malformed absolute links.
    return normalize(new URL(withProtocol).toString())
  } catch {
    return fallback
  }
}

export function resolveSiteUrl(env: SiteEnv): string {
  return toOrigin(env.NEXT_PUBLIC_WEB_SITE_URL || env.CF_PAGES_URL, DEV_SITE_URL)
}

export function resolveDocsUrl(env: SiteEnv): string {
  return toOrigin(env.NEXT_PUBLIC_DOCS_SITE_URL, DEV_DOCS_URL)
}

export function siteUrl(): string {
  return resolveSiteUrl(process.env as SiteEnv)
}

export function docsUrl(): string {
  return resolveDocsUrl(process.env as SiteEnv)
}

/** Join an app-absolute path onto the site origin. */
export function absoluteUrl(path: string): string {
  return `${siteUrl()}${path.startsWith("/") ? path : `/${path}`}`
}

/**
 * Join a path onto the docs origin. The docs site always carries an explicit
 * locale prefix (`hideLocale: "never"`), so callers pass one.
 */
export function docsLink(path: string): string {
  return `${docsUrl()}${path.startsWith("/") ? path : `/${path}`}`
}
