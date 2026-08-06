"use client"

import { useReducedMotion } from "motion/react"

import { Marquee } from "@web/components/ui/marquee"
import type { ContextTraceCopy } from "@web/content/types"

interface ContextTraceProps {
  copy: ContextTraceCopy
}

/**
 * A compact marquee interstitial between Hero and SignatureDemo.
 *
 * Scrolls context signals the agent consumed for the signature task —
 * repository, branch, files, plan, approval, tests. All items derive from
 * `DEMO_TASK` and are verifiable in the sections below.
 *
 * Reduced-motion: renders one static row, no scrolling.
 * Duplicate tracks are aria-hidden (handled by Marquee internals).
 */
export function ContextTrace({ copy }: ContextTraceProps) {
  const reduced = useReducedMotion()

  if (reduced) {
    return (
      <aside className="border-y border-hairline bg-surface py-5">
        <div className="mx-auto max-w-shell px-5 lg:px-8">
          <h2 className="sr-only">{copy.srLabel}</h2>
          <div className="flex flex-wrap items-center justify-center gap-4">
            {copy.items.map((item) => (
              <TraceItem key={item.key} label={item.label} />
            ))}
          </div>
        </div>
      </aside>
    )
  }

  return (
    <aside className="overflow-hidden border-y border-hairline bg-surface py-5">
      <h2 className="sr-only">{copy.srLabel}</h2>
      <Marquee pauseOnHover className="[--duration:30s] [--gap:2rem]">
        {copy.items.map((item) => (
          <TraceItem key={item.key} label={item.label} />
        ))}
      </Marquee>
    </aside>
  )
}

function TraceItem({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap font-mono text-xs uppercase tracking-widest text-muted">
      <span aria-hidden className="size-1.5 rounded-full bg-action" />
      {label}
    </span>
  )
}
