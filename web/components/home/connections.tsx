import { Reveal } from "@web/components/reveal"
import { Section, SectionHeading } from "@web/components/section"
import type { ConnectionsCopy } from "@web/content/types"

interface ConnectionsProps {
  copy: ConnectionsCopy
}

/**
 * "Connect tools without losing the task." (spec §4.6)
 *
 * Four task receipts, not a scrolling logo ticker. Each answers the same three
 * questions — reads, can act, requires approval — because that is what a reader
 * evaluating a connection needs, and a logo answers none of them.
 *
 * The full provider, MCP, plugin and connector catalogs stay in the
 * documentation; a homepage that lists them goes stale the week it ships.
 */
export function Connections({ copy }: ConnectionsProps) {
  const terms = [copy.headings.reads, copy.headings.canAct, copy.headings.requiresApproval]

  return (
    <Section id="connections" tone="surface">
      <SectionHeading eyebrow={copy.eyebrow} title={copy.title} subtitle={copy.subtitle} />

      <Reveal className="mt-14">
        <ul className="grid gap-px overflow-hidden rounded-stage border border-hairline bg-hairline md:grid-cols-2 xl:grid-cols-4">
          {copy.items.map((item, index) => (
            <li key={item.key} className="flex flex-col bg-surface p-6 md:p-8">
              {/* Receipt header: an index mark and the connection's name, so the
               * four read as numbered records rather than as four cards. */}
              <div className="flex items-baseline gap-3 border-b border-hairline pb-4">
                {/* The index reads in `muted`, not `action`: cyan is 1.69:1 on
                 * this substrate, and the token's own rule is that it is a
                 * line, a dot or a fill — never a text colour. The accent it
                 * used to carry moves to the dot beside it, which is
                 * decoration and free to be low-contrast. */}
                <span
                  aria-hidden
                  className="size-1 shrink-0 translate-y-[-0.15em] rounded-full bg-action"
                />
                <span aria-hidden className="font-mono text-[10px] text-muted">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <p className="font-medium text-ink">{item.name}</p>
              </div>
              <dl className="mt-5 flex flex-1 flex-col gap-4">
                {[
                  [terms[0], item.reads],
                  [terms[1], item.canAct],
                  [terms[2], item.requiresApproval],
                ].map(([term, value]) => (
                  <div key={term}>
                    <dt className="font-mono text-xs uppercase tracking-widest text-muted">
                      {term}
                    </dt>
                    <dd className="mt-1.5 text-sm leading-relaxed text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      </Reveal>

      <p className="mt-10 max-w-2xl text-sm leading-relaxed text-muted">{copy.catalogueNote}</p>
    </Section>
  )
}
