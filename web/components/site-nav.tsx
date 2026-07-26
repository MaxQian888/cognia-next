"use client"

import { useEffect } from "react"
import type { SiteCopy } from "@web/content/types"
import type { ReleaseState } from "@web/lib/evidence"
import { useDismissable } from "@web/hooks/use-dismissable"
import type { Locale } from "@web/lib/locale"
import { REPO_URL } from "@web/lib/site"
import { DownloadCta } from "./download-cta"
import { LanguageSwitcher } from "./language-switcher"
import { SiteLink } from "./site-link"
import { ThemeToggle } from "./theme-toggle"

interface SiteNavProps {
  locale: Locale
  /** Unprefixed route of the current page, for the language switcher. */
  route: string
  copy: SiteCopy
  releaseState: ReleaseState
  docsOrigin?: string
}

/**
 * Primary navigation (spec §5).
 *
 * Collapse order is deliberate: Product, Workflows and Plugins hide first as
 * the viewport narrows, while Docs, GitHub and Download stay reachable at every
 * width — those three are the ones a visitor came for.
 *
 * The mobile presentation is a full-screen sheet rather than a horizontally
 * compressed bar, so the same links stay legible instead of shrinking into a
 * row of ambiguous glyphs.
 */
export function SiteNav({ locale, route, copy, releaseState, docsOrigin }: SiteNavProps) {
  // Destructured rather than held as `menu.…`/`sheet.…`: the hook returns state
  // and refs together, and reading either through the object makes every access
  // look like a ref read during render to the compiler's lint rule. Separate
  // bindings keep the boundary visible to the reader too.
  const {
    open: menuOpen,
    toggle: toggleMenu,
    containerRef: menuRef,
    triggerRef: menuTriggerRef,
  } = useDismissable<HTMLDivElement>()
  const {
    open: sheetOpen,
    toggle: toggleSheet,
    containerRef: sheetRef,
    triggerRef: sheetTriggerRef,
  } = useDismissable<HTMLDivElement>()

  // A full-screen sheet that lets the page scroll underneath reads as broken.
  useEffect(() => {
    if (!sheetOpen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previous
    }
  }, [sheetOpen])

  const primaryLinks = copy.nav.links

  return (
    <header className="sticky top-0 z-50 border-b border-hairline bg-paper/85 backdrop-blur-sm">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-control focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:text-paper"
      >
        {copy.nav.skipToContent}
      </a>

      <nav
        aria-label={copy.nav.productMenu.label}
        className="mx-auto flex h-16 max-w-shell items-center gap-6 px-5 lg:px-8"
      >
        <SiteLink
          target={{ label: copy.nav.brand, route: "/" }}
          locale={locale}
          docsOrigin={docsOrigin}
          className="font-mono text-sm tracking-tight text-ink"
        />

        <div className="hidden items-center gap-1 lg:flex">
          <div className="relative">
            <button
              ref={menuTriggerRef}
              type="button"
              onClick={toggleMenu}
              aria-expanded={menuOpen}
              aria-haspopup="true"
              className="rounded-control px-3 py-2 text-sm text-muted transition-colors hover:text-ink"
            >
              {copy.nav.productMenu.label}
            </button>
            {menuOpen ? (
              <div
                ref={menuRef}
                className="absolute left-0 top-full w-80 rounded-panel border border-hairline bg-surface p-2 shadow-sm"
              >
                <ul>
                  {copy.nav.productMenu.items.map((item) => (
                    <li key={item.route}>
                      <SiteLink
                        target={item}
                        locale={locale}
                        docsOrigin={docsOrigin}
                        className="block rounded-control px-3 py-2 transition-colors hover:bg-paper"
                      >
                        <span className="block text-sm text-ink">{item.label}</span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                          {item.description}
                        </span>
                      </SiteLink>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          {primaryLinks.map((link) => (
            <SiteLink
              key={link.route}
              target={link}
              locale={locale}
              docsOrigin={docsOrigin}
              className="rounded-control px-3 py-2 text-sm text-muted transition-colors hover:text-ink"
            />
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <SiteLink
            target={{ label: copy.nav.docsLabel, docsPath: "/docs" }}
            locale={locale}
            docsOrigin={docsOrigin}
            className="rounded-control px-3 py-2 text-sm text-muted transition-colors hover:text-ink"
          />
          <SiteLink
            target={{ label: copy.nav.sourceLabel, href: REPO_URL }}
            locale={locale}
            docsOrigin={docsOrigin}
            className="hidden rounded-control px-3 py-2 text-sm text-muted transition-colors hover:text-ink sm:inline-flex"
          />
          <div className="hidden items-center gap-2 lg:flex">
            <LanguageSwitcher
              locale={locale}
              route={route}
              copy={copy.nav}
              docsOrigin={docsOrigin}
            />
            <ThemeToggle copy={copy.nav} />
          </div>
          <DownloadCta
            locale={locale}
            copy={copy.common}
            state={releaseState}
            variant="compact"
            docsOrigin={docsOrigin}
          />
          <button
            ref={sheetTriggerRef}
            type="button"
            onClick={toggleSheet}
            aria-expanded={sheetOpen}
            className="rounded-control border border-hairline px-3 py-2 text-sm text-ink lg:hidden"
          >
            {sheetOpen ? copy.nav.closeMenu : copy.nav.openMenu}
          </button>
        </div>
      </nav>

      {sheetOpen ? (
        <div
          ref={sheetRef}
          className="fixed inset-0 top-16 z-40 overflow-y-auto bg-paper px-5 py-8 lg:hidden"
        >
          <ul className="flex flex-col gap-1">
            {copy.nav.productMenu.items.map((item) => (
              <li key={item.route}>
                <SiteLink
                  target={item}
                  locale={locale}
                  docsOrigin={docsOrigin}
                  className="block border-b border-hairline py-4 text-lg text-ink"
                />
              </li>
            ))}
            {primaryLinks.map((link) => (
              <li key={link.route}>
                <SiteLink
                  target={link}
                  locale={locale}
                  docsOrigin={docsOrigin}
                  className="block border-b border-hairline py-4 text-lg text-ink"
                />
              </li>
            ))}
            <li>
              <SiteLink
                target={{ label: copy.nav.sourceLabel, href: REPO_URL }}
                locale={locale}
                docsOrigin={docsOrigin}
                className="block border-b border-hairline py-4 text-lg text-ink"
              />
            </li>
          </ul>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <LanguageSwitcher
              locale={locale}
              route={route}
              copy={copy.nav}
              docsOrigin={docsOrigin}
            />
            <ThemeToggle copy={copy.nav} />
          </div>
        </div>
      ) : null}
    </header>
  )
}
