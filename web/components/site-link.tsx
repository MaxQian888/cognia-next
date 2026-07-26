import Link from "next/link"
import type { ReactNode } from "react"
import type { LinkTarget } from "@web/content/types"
import { resolveLink } from "@web/lib/links"
import type { Locale } from "@web/lib/locale"
import { docsUrl } from "@web/lib/site"

interface SiteLinkProps {
  target: LinkTarget
  locale: Locale
  className?: string
  children?: ReactNode
  /**
   * Language of the destination, when it differs from the current page — the
   * language switcher is the one place on the site where it does.
   */
  hrefLang?: string
  /** Injected in tests; production always reads the configured docs origin. */
  docsOrigin?: string
}

/**
 * The single anchor used for every copy-declared destination.
 *
 * Internal routes go through `next/link` so the static export prefetches them;
 * anything on another origin — including the documentation site — becomes a
 * plain anchor that opens in a new tab and carries `rel="noreferrer"`, so the
 * decision is made once instead of at forty call sites.
 */
export function SiteLink({
  target,
  locale,
  className,
  children,
  hrefLang,
  docsOrigin,
}: SiteLinkProps) {
  const { href, external } = resolveLink(target, locale, docsOrigin ?? docsUrl())
  const content = children ?? target.label

  if (external) {
    return (
      <a href={href} className={className} hrefLang={hrefLang} target="_blank" rel="noreferrer">
        {content}
      </a>
    )
  }

  return (
    <Link href={href} className={className} hrefLang={hrefLang}>
      {content}
    </Link>
  )
}
