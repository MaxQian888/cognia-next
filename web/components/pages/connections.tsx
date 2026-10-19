"use client"

import { useState, type CSSProperties } from "react"

import { Reveal } from "@web/components/reveal"
import { Section, SectionHeading } from "@web/components/section"
import type { ConnectionFlowCopy, ConnectionsCopy } from "@web/content/types"
import { cn } from "@web/lib/utils"
import { ConnectionFlow } from "./connection-flow"

interface ConnectionsProps {
  /** One-based position on the page, rendered as the heading index tag. */
  index?: number
  copy: ConnectionsCopy
  flowCopy?: ConnectionFlowCopy
}

/**
 * "Connect tools without losing the task." (spec §4.6)
 *
 * Four task receipts, not a scrolling logo ticker. Each answers the same three
 * questions — reads, can act, requires approval — because that is what a reader
 * evaluating a connection needs, and a logo answers none of them.
 *
 * The full provider, MCP, plugin and connector catalogs stay in the
 * documentation; a page that lists them goes stale the week it ships.
 *
 * Moved from the homepage to /plugins (2026-10-19): the homepage now argues
 * what the workspace is, and a connection's boundary is the plugin page's
 * subject. The agent interop index it used to close on lives with the run
 * strategies (`AgentInteropStrip`).
 */
export function Connections({ copy, flowCopy, index }: ConnectionsProps) {
  const terms = [copy.headings.reads, copy.headings.canAct, copy.headings.requiresApproval]
  const [activeReceipt, setActiveReceipt] = useState<number | null>(null)
  const receiptColumns = copy.items
    .map((_, index) => (activeReceipt === index ? "1.35fr" : "1fr"))
    .join(" ")
  const receiptStyle = { "--receipt-columns": receiptColumns } as CSSProperties

  return (
    <Section id="connections" tone="surface">
      <SectionHeading
        index={index}
        eyebrow={copy.eyebrow}
        title={copy.title}
        subtitle={copy.subtitle}
      />

      {flowCopy ? (
        <Reveal className="mt-14">
          <ConnectionFlow
            copy={flowCopy}
            nodeLabels={copy.items.map((item) => item.name)}
            approvalLabel={copy.headings.requiresApproval}
            activeIndex={activeReceipt}
            onActiveIndexChange={setActiveReceipt}
          />
        </Reveal>
      ) : null}

      <Reveal className={flowCopy ? "mt-10" : "mt-14"}>
        <ul
          data-slot="connection-receipts"
          style={receiptStyle}
          className="grid gap-px border-y border-hairline bg-hairline transition-[grid-template-columns] duration-500 ease-out md:grid-cols-2 xl:grid-cols-[var(--receipt-columns)]"
        >
          {copy.items.map((item, index) => (
            <li
              key={item.key}
              data-active={activeReceipt === index ? "true" : undefined}
              onMouseEnter={() => setActiveReceipt(index)}
              onMouseLeave={() => setActiveReceipt(null)}
              className={cn(
                "flex min-w-0 flex-col bg-surface p-6 transition-colors md:p-8",
                activeReceipt === index && "bg-paper"
              )}
            >
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
