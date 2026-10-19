import type { ReactNode } from "react"
import { Icon, type IconName } from "@web/components/icon"
import { PluginManifestReconstruction } from "@web/components/product/plugin-manifest-reconstruction"
import { RunLedgerReconstruction } from "@web/components/product/run-ledger-reconstruction"
import { WorkflowGraphReconstruction } from "@web/components/product/workflow-graph-reconstruction"
import { Section } from "@web/components/section"
import type { CapabilitySection, ReconstructionCopy } from "@web/content/types"
import type { Locale } from "@web/lib/locale"
import { CapabilityGrid } from "./capability-grid"

interface CapabilitySectionsProps {
  sections: CapabilitySection[]
  learnMore: string
  locale: Locale
  docsOrigin?: string
  /**
   * Copy for the interface reconstructions that fill a section's spare grid
   * cells. Omit and sections render their entries alone.
   */
  reconstruction?: ReconstructionCopy
  /**
   * Per-section additions, keyed by anchor id. `figure` sets the section's
   * entries in one column beside a product visual — a capture or a labelled
   * reconstruction of the surface the section is about. `after` renders under
   * the entries, for an index that belongs to the section but is not an entry.
   */
  extras?: Record<string, SectionExtras>
  /**
   * Tone of the first section. A page that opens on its own paper section
   * before these starts them on `surface`, so two paper blocks never meet
   * without a boundary.
   */
  startTone?: "paper" | "surface"
}

export interface SectionExtras {
  figure?: ReactNode
  after?: ReactNode
}

/**
 * The reconstruction that fills a section's spare cells, keyed by anchor id.
 *
 * Only sections whose entry count leaves the three-column grid open have one,
 * and each shows the surface the section is about: the graph for Build, the
 * run ledger for Run, the manifest for what a plugin contributes. A section
 * with no entry closes its grid on its own.
 */
const SECTION_ASIDE: Record<string, (copy: ReconstructionCopy) => ReactNode> = {
  // Live: the graph builds itself and refuses a cycle, the ledger plays a run.
  build: (copy) => <WorkflowGraphReconstruction copy={copy} live />,
  run: (copy) => <RunLedgerReconstruction copy={copy} live />,
  surfaces: (copy) => <PluginManifestReconstruction copy={copy} />,
}

/**
 * One mark per section, keyed by the anchor the section already carries.
 *
 * Icons are presentation, not content, so they live here rather than in
 * `SiteCopy` — a translator has nothing to say about them, and a section with
 * no entry simply renders without one.
 */
const SECTION_ICON: Record<string, IconName> = {
  chat: "chat",
  agents: "agents",
  knowledge: "knowledge",
  desktop: "system",
  mobile: "mobile",
  im: "chat",
  cli: "terminal",
  browser: "appWindow",
  build: "workflow",
  run: "play",
  observe: "record",
  authoring: "plugin",
  capabilities: "approval",
  surfaces: "plugin",
  source: "source",
  data: "data",
  permission: "approval",
  record: "record",
}

/**
 * The body shared by /product, /workflows, /plugins and /trust.
 *
 * Alternating tones keep long pages from reading as one undifferentiated
 * column, and each section carries its anchor id so the navigation dropdown and
 * the footer land on the right block.
 *
 * The heading splits into two columns from `lg`. In one column a one-line title
 * sits directly on top of a three-line subtitle inside `max-w-3xl` of a 1480px
 * shell — the same crowding as the old hero, repeated three or four times per
 * page.
 *
 * The vertical rhythm alternates as well, and that is the more important half.
 * Tone alone gives a boundary between two blocks; it does not give the page a
 * cadence, because both blocks are still the same size. Measured against four
 * peer sites (`docs/research/cognia-official-website-motion-craft-2026-08-01.md`),
 * the mechanism that reads as rhythm is alternation between a generous value
 * and a much smaller one — Raycast runs 168px against 0 — not an even ramp
 * across three similar values. With `/product` growing from four capability
 * sections to six, a page of six identically-spaced blocks is exactly the
 * failure this alternation exists to avoid.
 */
export function CapabilitySections({
  sections,
  learnMore,
  locale,
  docsOrigin,
  reconstruction,
  extras,
  startTone = "paper",
}: CapabilitySectionsProps) {
  const [even, odd] =
    startTone === "paper" ? (["paper", "surface"] as const) : (["surface", "paper"] as const)
  return (
    <>
      {sections.map((section, index) => {
        const tone = index % 2 === 0 ? even : odd
        // The first block sets the page's upper bound; after it the rhythm
        // alternates, so no two adjacent sections are the same height.
        // `normal`, not `open`: measured on the shipped pages the opening block
        // carried 400px of ruled paper above its heading, which read as the
        // page having stalled rather than as an index beginning.
        const density = index === 0 ? "normal" : index % 2 === 1 ? "tight" : "normal"
        const icon = section.id ? SECTION_ICON[section.id] : undefined
        const extra = section.id ? extras?.[section.id] : undefined
        const aside =
          reconstruction && section.id && SECTION_ASIDE[section.id]
            ? SECTION_ASIDE[section.id](reconstruction)
            : undefined
        return (
          <Section key={section.title} id={section.id} tone={tone} density={density}>
            <div className="lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16">
              <div>
                <h2 className="flex items-start gap-3 text-balance text-3xl font-medium leading-tight tracking-tight text-ink md:text-4xl lg:text-5xl">
                  {icon ? <Icon name={icon} size={20} className="mt-2 text-muted" /> : null}
                  {section.title}
                </h2>
              </div>
              <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted lg:mt-0 lg:self-end lg:pb-2">
                {section.subtitle}
              </p>
            </div>

            {extra?.figure ? (
              // Entries beside the figure from `lg`: the figure takes the wider
              // track because it is the evidence, and the three entries read as
              // its legend. Below `lg` the figure comes first, so a phone sees
              // the surface before the list that describes it.
              <div
                data-slot="capability-figure-row"
                className="mt-12 flex flex-col-reverse gap-10 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:gap-12"
              >
                <CapabilityGrid
                  entries={section.entries}
                  learnMore={learnMore}
                  locale={locale}
                  tone={tone}
                  docsOrigin={docsOrigin}
                  layout="stack"
                />
                <div className="min-w-0">{extra.figure}</div>
              </div>
            ) : (
              <div className="mt-12">
                <CapabilityGrid
                  entries={section.entries}
                  learnMore={learnMore}
                  locale={locale}
                  tone={tone}
                  docsOrigin={docsOrigin}
                  aside={aside}
                />
              </div>
            )}
            {extra?.after ? <div className="mt-14">{extra.after}</div> : null}
          </Section>
        )
      })}
    </>
  )
}
