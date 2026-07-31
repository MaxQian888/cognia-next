/**
 * Absolute-URL resolution for the docs site.
 *
 * Sitemaps, canonical tags, hreflang alternates, OpenGraph images and the
 * `/llms.txt` family all need an origin, and a static export has no request to
 * read one from — it has to be baked in at build time.
 *
 * Resolution order:
 *   1. `NEXT_PUBLIC_DOCS_SITE_URL` — set this in the deploy workflow to the
 *      real custom domain. Nothing else knows it: the Cloudflare Pages project
 *      is referenced only through the `CF_DOCS_PAGES_PROJECT` repo variable.
 *   2. `CF_PAGES_URL` — injected automatically by Cloudflare Pages builds, so
 *      preview deployments get correct absolute URLs for free.
 *   3. the dev origin, which keeps `pnpm docs:dev` self-consistent.
 */

export const DEV_SITE_URL = "http://localhost:3001"

/** Matches the nav title in `lib/layout.shared.tsx`. */
export const SITE_NAME = "Cognia"

type SiteEnv = {
  NEXT_PUBLIC_DOCS_SITE_URL?: string
  CF_PAGES_URL?: string
}

/** Strip trailing slashes so callers can always concatenate `/`-prefixed paths. */
function normalize(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

export function resolveSiteUrl(env: SiteEnv): string {
  const candidate = env.NEXT_PUBLIC_DOCS_SITE_URL?.trim() || env.CF_PAGES_URL?.trim()
  if (!candidate) return DEV_SITE_URL

  const withProtocol = /^https?:\/\//.test(candidate) ? candidate : `https://${candidate}`
  try {
    // Reject values that are not URLs at all rather than emitting a sitemap
    // full of malformed absolute links.
    return normalize(new URL(withProtocol).toString())
  } catch {
    return DEV_SITE_URL
  }
}

export function siteUrl(): string {
  return resolveSiteUrl(process.env as SiteEnv)
}

/** Join an app-absolute path onto the site origin. */
export function absoluteUrl(path: string): string {
  return `${siteUrl()}${path.startsWith("/") ? path : `/${path}`}`
}
