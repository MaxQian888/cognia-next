import { Glyph } from "@web/components/glyph"
import { ProductStage } from "@web/components/product-stage"
import { Reveal } from "@web/components/reveal"
import { Section, SectionHeading } from "@web/components/section"
import { SiteLink } from "@web/components/site-link"
import type { DesktopCopy, EntryPointStation, TerminalCopy } from "@web/content/types"
import type { Locale } from "@web/lib/locale"
import { SURFACE_GLYPH, surfaceRoute } from "@web/lib/surfaces"
import { DesktopTerminal } from "./desktop-terminal"
import { StageLens } from "./stage-lens"

interface DesktopSectionProps {
  /** One-based position on the page, rendered as the heading index tag. */
  index?: number
  copy: DesktopCopy
  terminalCopy?: TerminalCopy
  locale: Locale
  /** Accessible name for the hover lens over the stage. Omit to render none. */
  lensLabel?: string
  /**
   * The surfaces that reach this workspace (`SurfacesPageCopy.entryPoints`).
   * The desktop itself is this section, so the strip lists the others.
   */
  stations?: EntryPointStation[]
  docsOrigin?: string
}

/**
 * "A workspace that stays close to the work." (spec §4.4)
 *
 * Large light negative space and one macro crop of the real shell — no device
 * mock-up, no floating laptop. Every capability listed is one that ships; the
 * section argues for installing the application, so an aspirational entry here
 * would be the most expensive kind of overclaim.
 */
export function DesktopSection({
  copy,
  terminalCopy,
  locale,
  lensLabel,
  stations,
  docsOrigin,
  index,
}: DesktopSectionProps) {
  const others = (stations ?? []).filter((station) => station.key !== "desktop")
  const stage = <ProductStage section="desktop" locale={locale} alt={copy.stageAlt} />
  return (
    <Section id="desktop" tone="surface" density="tight">
      <SectionHeading
        index={index}
        eyebrow={copy.eyebrow}
        title={copy.title}
        subtitle={copy.subtitle}
      />

      <div className="mt-16 border-y border-hairline">
        <div className="grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <ul className="flex flex-col border-b border-hairline py-6 lg:border-b-0 lg:border-r lg:pr-8">
            {copy.capabilities.map((capability) => (
              <li
                key={capability.label}
                className="border-t border-hairline py-5 first:border-t-0 first:pt-0"
              >
                <p className="font-mono text-xs uppercase tracking-widest text-ink">
                  {capability.label}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-muted">{capability.body}</p>
              </li>
            ))}
          </ul>

          {/* The lens lives here rather than on the hero: a magnifier over a
           * surface that is animating itself is two motions fighting, while
           * this crop is still and dense enough to reward a closer look. */}
          <Reveal variant="scale" className="min-w-0 py-6 lg:pl-10">
            {lensLabel ? <StageLens ariaLabel={lensLabel}>{stage}</StageLens> : stage}
          </Reveal>
        </div>

        {/* `stage-scope` remaps the status colours onto their stage values:
         * the paper success and destructive tokens fall under 3:1 on graphite.
         * The band is the terminal's only frame — a bordered terminal inset in
         * a graphite block read as a card inside a card. */}
        {terminalCopy ? (
          <div
            data-slot="desktop-terminal-band"
            className="stage-scope border-t border-on-stage-hairline bg-graphite"
          >
            <DesktopTerminal copy={terminalCopy} />
          </div>
        ) : null}
      </div>

      {/* The rail that used to be its own homepage section, folded to one
       * row: each surface names the role it plays and links to its block on
       * /surfaces, where the full handoff is told. */}
      {others.length > 0 ? (
        <div data-slot="surfaces-strip" className="mt-10">
          <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-3">
            <p className="font-mono text-xs uppercase tracking-widest text-muted">
              {copy.otherSurfaces.label}
            </p>
            <SiteLink
              target={{ label: copy.otherSurfaces.linkLabel, route: "/surfaces" }}
              locale={locale}
              docsOrigin={docsOrigin}
              className="inline-flex items-center gap-1 text-sm text-ink underline decoration-hairline-strong underline-offset-4 transition-colors hover:decoration-ink"
            >
              {copy.otherSurfaces.linkLabel}
              <span aria-hidden>→</span>
            </SiteLink>
          </div>
          <ul className="mt-4 grid gap-px border-y border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4">
            {others.map((station) => (
              <li key={station.key} className="bg-surface">
                <SiteLink
                  target={{ label: station.name, route: surfaceRoute(station.key) }}
                  locale={locale}
                  docsOrigin={docsOrigin}
                  className="trace group flex h-full items-start gap-4 p-5 transition-colors hover:bg-paper"
                >
                  <span className="mt-0.5 text-ink">
                    <Glyph name={SURFACE_GLYPH[station.key]} size={20} />
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-medium text-ink">{station.name}</span>
                    <span className="text-sm text-muted">{station.role}</span>
                  </span>
                </SiteLink>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  )
}
