"use client"

import { useEffect } from "react"
import { createPortal } from "react-dom"
import type { NavMenu, SiteCopy } from "@web/content/types"
import type { ReleaseState } from "@web/lib/evidence"
import { useDismissable } from "@web/hooks/use-dismissable"
import { BrandMark } from "./brand-mark"
import { Icon, type IconName } from "./icon"
import type { Locale } from "@web/lib/locale"
import { REPO_URL } from "@web/lib/site"
import { cn } from "@web/lib/utils"
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
    open: sheetOpen,
    toggle: toggleSheet,
    close: closeSheet,
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

  /**
   * One mark per destination, keyed by the route the content already carries.
   *
   * Presentation rather than content — a translator has nothing to say about
   * them — so they live here, the same split `capability-sections.tsx` makes. A
   * route with no entry renders without a mark instead of falling back to a
   * generic one, because a generic icon carries less than no icon.
   */
  const NAV_ICON: Record<string, IconName> = {
    "/product#chat": "chat",
    "/product#agents": "agents",
    "/product#knowledge": "knowledge",
    "/surfaces": "mobile",
    "/use-cases/development": "terminal",
    "/use-cases/research": "artifact",
    "/workflows": "workflow",
    "/plugins": "plugin",
    "/trust": "trust",
  }
  const menus = [copy.nav.productMenu, copy.nav.useCasesMenu]

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
          className="inline-flex items-center gap-2 font-mono text-sm tracking-tight text-ink"
        >
          <BrandMark className="text-ink" />
          {copy.nav.brand}
        </SiteLink>

        <div className="hidden items-center gap-1 lg:flex">
          {menus.map((menu) => (
            <NavDropdown
              key={menu.label}
              menu={menu}
              icons={NAV_ICON}
              locale={locale}
              docsOrigin={docsOrigin}
            />
          ))}

          {primaryLinks.map((link) => (
            <SiteLink
              key={link.route}
              target={link}
              locale={locale}
              docsOrigin={docsOrigin}
              className="inline-flex items-center gap-1.5 rounded-control px-3 py-2 text-sm text-muted transition-colors hover:text-ink"
            >
              {NAV_ICON[link.route] ? <Icon name={NAV_ICON[link.route]} size={14} /> : null}
              {link.label}
            </SiteLink>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <SiteLink
            target={{ label: copy.nav.docsLabel, docsPath: "/docs" }}
            locale={locale}
            docsOrigin={docsOrigin}
            className="inline-flex items-center gap-1.5 rounded-control px-3 py-2 text-sm text-muted transition-colors hover:text-ink"
          >
            <Icon name="files" size={14} />
            {copy.nav.docsLabel}
          </SiteLink>
          <SiteLink
            target={{ label: copy.nav.sourceLabel, href: REPO_URL }}
            locale={locale}
            docsOrigin={docsOrigin}
            className="hidden items-center gap-1.5 rounded-control px-3 py-2 text-sm text-muted transition-colors hover:text-ink sm:inline-flex"
          >
            <Icon name="source" size={14} />
            {copy.nav.sourceLabel}
          </SiteLink>
          <div className="hidden items-center gap-2 lg:flex">
            <LanguageSwitcher
              locale={locale}
              route={route}
              copy={copy.nav}
              docsOrigin={docsOrigin}
            />
            <ThemeToggle copy={copy.nav} />
          </div>
          <div className="hidden sm:inline-flex">
            <DownloadCta
              locale={locale}
              copy={copy.common}
              state={releaseState}
              variant="compact"
              docsOrigin={docsOrigin}
            />
          </div>
          <button
            ref={sheetTriggerRef}
            type="button"
            onClick={toggleSheet}
            aria-expanded={sheetOpen}
            aria-controls={sheetOpen ? "site-nav-sheet" : undefined}
            className="inline-flex items-center gap-1.5 rounded-control border border-hairline px-3 py-2 text-sm text-ink lg:hidden"
          >
            {/* Beside the words, never instead of them: the label is what
             * names this control for assistive technology and for anyone who
             * does not read the glyph. */}
            <Icon name={sheetOpen ? "close" : "menu"} size={14} />
            {sheetOpen ? copy.nav.closeMenu : copy.nav.openMenu}
          </button>
        </div>
      </nav>

      {/* Portalled to <body>: the header's `backdrop-filter` makes it the
       * containing block for fixed descendants, so a sheet rendered inside it
       * was sized to the 64px bar and its links spilled over the page. */}
      {sheetOpen
        ? createPortal(
            <div
              ref={sheetRef}
              id="site-nav-sheet"
              // Following a link must close the sheet: the nav survives
              // client-side navigation, and an in-page anchor would otherwise
              // land behind it.
              onClick={(event) => {
                if ((event.target as Element).closest("a")) closeSheet()
              }}
              className="fixed inset-x-0 bottom-0 top-16 z-40 overflow-y-auto overscroll-contain border-t border-hairline bg-paper px-5 py-8 lg:hidden"
            >
              {menus.map((menu) => (
                <div key={menu.label} className="mb-6">
                  <p className="font-mono text-xs uppercase tracking-widest text-muted">
                    {menu.label}
                  </p>
                  <ul className="mt-1 flex flex-col">
                    {menu.items.map((item) => (
                      <li key={item.route}>
                        <SiteLink
                          target={item}
                          locale={locale}
                          docsOrigin={docsOrigin}
                          className="flex items-center gap-3 border-b border-hairline py-4 text-lg text-ink"
                        >
                          {NAV_ICON[item.route] ? (
                            <Icon name={NAV_ICON[item.route]} size={16} className="text-muted" />
                          ) : null}
                          {item.label}
                        </SiteLink>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <ul className="flex flex-col gap-1">
                {primaryLinks.map((link) => (
                  <li key={link.route}>
                    <SiteLink
                      target={link}
                      locale={locale}
                      docsOrigin={docsOrigin}
                      className="flex items-center gap-3 border-b border-hairline py-4 text-lg text-ink"
                    >
                      {NAV_ICON[link.route] ? (
                        <Icon name={NAV_ICON[link.route]} size={16} className="text-muted" />
                      ) : null}
                      {link.label}
                    </SiteLink>
                  </li>
                ))}
                <li>
                  <SiteLink
                    target={{ label: copy.nav.sourceLabel, href: REPO_URL }}
                    locale={locale}
                    docsOrigin={docsOrigin}
                    className="flex items-center gap-3 border-b border-hairline py-4 text-lg text-ink"
                  >
                    <Icon name="source" size={16} className="text-muted" />
                    {copy.nav.sourceLabel}
                  </SiteLink>
                </li>
              </ul>

              {/* The bar hides Download below `sm`; the sheet is where it goes. */}
              <div className="mt-8 sm:hidden">
                <DownloadCta
                  locale={locale}
                  copy={copy.common}
                  state={releaseState}
                  variant="compact"
                  docsOrigin={docsOrigin}
                />
              </div>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <LanguageSwitcher
                  locale={locale}
                  route={route}
                  copy={copy.nav}
                  docsOrigin={docsOrigin}
                />
                <ThemeToggle copy={copy.nav} />
              </div>
            </div>,
            document.body
          )
        : null}
    </header>
  )
}

interface NavDropdownProps {
  menu: NavMenu
  icons: Record<string, IconName>
  locale: Locale
  docsOrigin?: string
}

/**
 * One labelled dropdown in the bar. Each owns its dismissal, so opening one
 * and pressing outside it — including on the other trigger — closes it, and
 * Escape returns focus to the control that opened it.
 */
function NavDropdown({ menu, icons, locale, docsOrigin }: NavDropdownProps) {
  const { open, toggle, close, containerRef, triggerRef } = useDismissable<HTMLDivElement>()
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="true"
        className="inline-flex items-center gap-1.5 rounded-control px-3 py-2 text-sm text-muted transition-colors hover:text-ink"
      >
        {menu.label}
        <Icon
          name="chevronDown"
          size={14}
          className={cn("transition-transform duration-200", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div
          ref={containerRef}
          // Following a link closes the menu: the bar survives client-side
          // navigation, and an anchor on the same page would leave it open.
          onClick={(event) => {
            if ((event.target as Element).closest("a")) close()
          }}
          className="nav-menu absolute left-0 top-full w-80 rounded-panel border border-hairline bg-surface p-2 shadow-sm"
        >
          <ul>
            {menu.items.map((item) => (
              <li key={item.route}>
                <SiteLink
                  target={item}
                  locale={locale}
                  docsOrigin={docsOrigin}
                  className="flex gap-3 rounded-control px-3 py-2 transition-colors hover:bg-paper"
                >
                  {icons[item.route] ? (
                    <Icon
                      name={icons[item.route]}
                      size={16}
                      className="mt-0.5 shrink-0 text-muted"
                    />
                  ) : null}
                  <span className="block">
                    <span className="block text-sm text-ink">{item.label}</span>
                    <span className="mt-0.5 block text-sm leading-relaxed text-muted">
                      {item.description}
                    </span>
                  </span>
                </SiteLink>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
