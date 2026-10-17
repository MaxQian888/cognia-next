"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"
import { useSearchContext } from "fumadocs-ui/contexts/search"

// Relative rather than `@/`: the repo's Jest runner maps that alias to the app
// root, not to `docs/`, and this component has tests.
import type { HomeGroup } from "../lib/home-sections"

type Props = {
  lang: string
  groups: HomeGroup[]
  /** The "Getting started" page; the primary call to action. */
  gettingStartedHref: string
  /** The docs overview (`/{lang}/docs`). */
  overviewHref: string
  repoUrl: string
  /** Null when the build has no marketing origin configured; the link is then omitted. */
  websiteUrl: string | null
}

/** Mono index tag + rule + label: the eyebrow every website section opens with. */
function Eyebrow({ index, children }: { index: string; children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-4 font-mono text-xs uppercase tracking-widest text-fd-muted-foreground">
      <span className="text-fd-foreground">{index}</span>
      <span aria-hidden className="h-px w-12 bg-cg-hairline-strong sm:w-16" />
      {children}
    </p>
  )
}

function Arrow({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      focusable="false"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      className={className}
    >
      <path
        d="M3 8h10M9 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * The docs landing page (`/{lang}`).
 *
 * It borrows the website's composition — mono index eyebrows, a ruled ground,
 * hairline-divided panels, one cyan accent — so arriving here from the website
 * reads as the same product rather than a stock documentation theme.
 *
 * The area index comes from the page tree (`lib/home-sections.ts`), so it is
 * always the sidebar's own structure, localized by the same `meta.json` titles.
 */
export function HomePage({
  lang,
  groups,
  gettingStartedHref,
  overviewHref,
  repoUrl,
  websiteUrl,
}: Props) {
  const t = useTranslations("docsSite.home")
  const search = useSearchContext()

  return (
    <div className="flex flex-1 flex-col">
      <section className="relative isolate overflow-hidden border-b border-fd-border">
        <div aria-hidden className="cg-rhythm-lines pointer-events-none absolute inset-0 -z-10" />
        <div className="mx-auto w-full max-w-6xl px-5 pb-16 pt-16 md:pb-24 md:pt-24 lg:px-8">
          <Eyebrow index="01">{t("eyebrow")}</Eyebrow>
          <h1 className="mt-8 max-w-4xl text-balance text-4xl font-medium leading-[1.08] tracking-tight text-fd-foreground md:text-6xl">
            {t("title")}
          </h1>
          <p className="mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-fd-muted-foreground md:text-xl">
            {t("subtitle")}
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <Link
              href={gettingStartedHref}
              className="inline-flex items-center gap-2 rounded-cg-control bg-cg-ink px-5 py-3 text-sm font-medium text-cg-paper transition-opacity hover:opacity-90"
            >
              {t("primaryCta")}
              <Arrow />
            </Link>
            <Link
              href={overviewHref}
              className="inline-flex items-center gap-2 rounded-cg-control border border-cg-hairline-strong px-5 py-3 text-sm text-fd-foreground transition-colors hover:bg-fd-accent"
            >
              {t("secondaryCta")}
            </Link>
            {search.enabled ? (
              <button
                type="button"
                onClick={() => search.setOpenSearch(true)}
                className="inline-flex w-full items-center gap-3 rounded-cg-control border border-fd-border bg-fd-card px-4 py-3 text-left text-sm text-fd-muted-foreground transition-colors hover:text-fd-foreground sm:w-72"
              >
                <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
                  <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" />
                </svg>
                {t("searchHint")}
                <kbd className="ml-auto hidden rounded border border-fd-border px-1.5 font-mono text-xs sm:inline">
                  ⌘K
                </kbd>
              </button>
            ) : null}
          </div>

          <p className="mt-8 flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs uppercase tracking-widest text-fd-muted-foreground">
            <a href={repoUrl} className="transition-colors hover:text-fd-foreground">
              {t("github")} ↗
            </a>
            {websiteUrl ? (
              <a
                href={lang === "zh" ? `${websiteUrl}/zh` : websiteUrl}
                className="transition-colors hover:text-fd-foreground"
              >
                {t("website")} ↗
              </a>
            ) : null}
          </p>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-5 py-16 md:py-24 lg:px-8">
        <Eyebrow index="02">{t("browseEyebrow")}</Eyebrow>
        <h2 className="mt-6 max-w-3xl text-balance text-3xl font-medium tracking-tight text-fd-foreground md:text-4xl">
          {t("browseTitle")}
        </h2>

        {/* One grid across every group rather than a grid per group: most
         * groups hold one or two areas, and per-group rows left most of each
         * row empty. The group survives as the card's mono tag. */}
        <ul className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {groups.flatMap((group) =>
            group.sections.map((section) => (
              <li key={section.href} className="flex">
                <Link
                  href={section.href}
                  className="group flex w-full flex-col rounded-cg-panel border border-fd-border bg-fd-card p-5 transition-colors hover:border-cg-hairline-strong hover:bg-fd-accent/40 md:p-6"
                >
                  {group.label ? (
                    <span className="font-mono text-[11px] uppercase tracking-widest text-fd-muted-foreground">
                      {group.label}
                    </span>
                  ) : null}
                  <span className="mt-2 flex items-baseline justify-between gap-3">
                    <span className="text-base font-medium text-fd-foreground">
                      {section.title}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-fd-muted-foreground">
                      {t("pageCount", { count: section.pageCount })}
                    </span>
                  </span>
                  <span className="mt-3 flex flex-col gap-1 text-sm text-fd-muted-foreground">
                    {section.preview.map((name) => (
                      <span key={name} className="truncate">
                        {name}
                      </span>
                    ))}
                  </span>
                  <span className="mt-auto inline-flex items-center gap-1.5 pt-5 text-xs text-fd-muted-foreground transition-colors group-hover:text-fd-foreground">
                    <span aria-hidden className="size-1.5 rounded-full bg-cg-action" />
                    {t("openArea")}
                    <Arrow className="transition-transform group-hover:translate-x-0.5" />
                  </span>
                </Link>
              </li>
            ))
          )}
        </ul>

        <div className="mt-16 flex flex-col gap-4 rounded-cg-panel border border-fd-border bg-fd-card p-6 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="font-medium text-fd-foreground">{t("llmsTitle")}</p>
            <p className="mt-1 text-sm text-fd-muted-foreground">{t("llmsBody")}</p>
          </div>
          <div className="flex flex-wrap gap-2 font-mono text-xs">
            <a
              href="/llms.txt"
              className="rounded-cg-control border border-fd-border px-3 py-2 text-fd-foreground transition-colors hover:bg-fd-accent"
            >
              {t("llmsIndex")}
            </a>
            <a
              href={`/${lang}/llms-full.txt`}
              className="rounded-cg-control border border-fd-border px-3 py-2 text-fd-foreground transition-colors hover:bg-fd-accent"
            >
              {t("llmsFull")}
            </a>
          </div>
        </div>
      </section>
    </div>
  )
}
