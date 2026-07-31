import { AgentMark } from "@web/components/agent-mark"
import { Icon } from "@web/components/icon"
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

      {/* Agent interop (spec §4.6, amended 2026-08-01).
       *
       * The four receipts above answer "what can this connect to". This answers
       * a different question the same section is the right place for: "does it
       * work with the agent I already use". Every row is backed by real code —
       * an external-agent preset, a session-import adapter, or both — and the
       * two capability marks say which, so no row implies more than it has.
       *
       * §4.5 rules out a model logo wall and §4.6 rules out a scrolling
       * ticker; this is neither. The marks are monochrome and inherit the
       * page's ink, the rows are a static index, and the capability is stated
       * in words beside each name rather than implied by the presence of a
       * logo. */}
      <Reveal className="mt-16">
        <div className="border-t border-hairline pt-10">
          <div className="flex flex-wrap items-baseline justify-between gap-x-10 gap-y-3">
            <p className="font-mono text-xs uppercase tracking-widest text-muted">
              {copy.agents.label}
            </p>
            <p className="max-w-2xl text-sm leading-relaxed text-muted">{copy.agents.note}</p>
          </div>

          <ul
            aria-label={copy.agents.label}
            className="mt-8 grid gap-px overflow-hidden rounded-stage border border-hairline bg-hairline sm:grid-cols-2 xl:grid-cols-5"
          >
            {copy.agents.items.map((agent) => (
              <li key={agent.id} className="trace flex flex-col gap-3 bg-surface p-5">
                <span className="flex items-center gap-2.5">
                  <AgentMark id={agent.id} className="shrink-0 text-ink" />
                  <span className="text-sm font-medium text-ink">{agent.name}</span>
                </span>
                <span className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-widest text-muted">
                  {agent.run ? (
                    <span className="flex items-center gap-1">
                      <Icon name="play" size={14} />
                      {copy.agents.runLabel}
                    </span>
                  ) : null}
                  {agent.import ? (
                    <span className="flex items-center gap-1">
                      <Icon name="record" size={14} />
                      {copy.agents.importLabel}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Reveal>
    </Section>
  )
}
