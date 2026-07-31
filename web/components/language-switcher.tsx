import type { NavCopy } from "@web/content/types"
import { Icon } from "./icon"
import { type Locale, HTML_LANG, otherLocale } from "@web/lib/locale"
import { SiteLink } from "./site-link"

interface LanguageSwitcherProps {
  locale: Locale
  route: string
  copy: NavCopy
  docsOrigin?: string
}

/**
 * Links to the current page in the other locale, never to that locale's
 * homepage — landing a reader back at the top of the site is the most common
 * way a language switcher wastes the click.
 *
 * `hrefLang` and `lang` are both set: the destination is in a different
 * language from the surrounding page, so assistive technology needs the label
 * announced in its own language rather than the page's.
 */
export function LanguageSwitcher({ locale, route, copy, docsOrigin }: LanguageSwitcherProps) {
  const target = otherLocale(locale)

  return (
    <SiteLink
      target={{ label: copy.switchLanguageTo, route }}
      locale={target}
      hrefLang={HTML_LANG[target]}
      docsOrigin={docsOrigin}
      className="inline-flex h-8 items-center gap-1.5 rounded-control border border-hairline px-2.5 text-xs text-muted transition-colors hover:text-ink"
    >
      {/* The glyph is what makes this scannable at a glance; the target
       * language stays in words beside it, because "中文" / "English" is the
       * only thing that actually says where the link goes. A globe alone would
       * not. */}
      <Icon name="language" size={14} />
      <span lang={HTML_LANG[target]}>{copy.switchLanguageTo}</span>
    </SiteLink>
  )
}
