import type { LinkTarget } from "@web/content/types"
import { type Locale, localePath } from "./locale"

/**
 * Link resolution (ADR-0092 §2).
 *
 * A copy entry names its destination as exactly one of:
 *   `route`    a path on this site, which gains a locale prefix
 *   `docsPath` a path on the documentation site, which is a different hostname
 *              and carries its own always-explicit locale prefix
 *   `href`     an absolute external URL, used verbatim
 *
 * Resolving all three in one place is what keeps a locale prefix from being
 * forgotten on one link out of forty, and what guarantees every off-site anchor
 * carries `rel="noreferrer"`.
 */

export interface ResolvedLink {
  href: string
  /** True for anything not served by this site — drives `target`/`rel`. */
  external: boolean
}

/**
 * Split a trailing `#anchor` off a route so the locale prefix lands on the path
 * and not in front of the fragment. `/product#chat` must become `/zh/product#chat`,
 * never `/zh/product%23chat` or `/product#chat` with the prefix lost.
 */
export function splitHash(route: string): { path: string; hash: string } {
  const index = route.indexOf("#")
  if (index === -1) return { path: route, hash: "" }
  return { path: route.slice(0, index) || "/", hash: route.slice(index) }
}

/** A site route with its locale prefix and fragment applied. */
export function routeHref(locale: Locale, route: string): string {
  const { path, hash } = splitHash(route)
  return `${localePath(locale, path)}${hash}`
}

/**
 * A path on the docs site. The docs site sets `hideLocale: "never"`, so the
 * prefix is always explicit there — `/en/docs/...`, never `/docs/...`.
 */
export function docsHref(origin: string, locale: Locale, path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`
  return `${origin}/${locale}${normalized}`
}

export function resolveLink(target: LinkTarget, locale: Locale, docsOrigin: string): ResolvedLink {
  if (target.href) return { href: target.href, external: true }
  if (target.docsPath) {
    return { href: docsHref(docsOrigin, locale, target.docsPath), external: true }
  }
  if (target.route) return { href: routeHref(locale, target.route), external: false }
  // A copy entry with no destination is a content bug, not a rendering one; the
  // parity test in `web/content` asserts this never ships.
  throw new Error(`Link target "${target.label}" declares no destination`)
}
