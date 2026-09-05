"use client"

import { useReducedMotion } from "motion/react"

import {
  WORKBENCH_COMPLETE,
  WorkbenchReconstruction,
} from "@web/components/product/workbench-reconstruction"
import { BorderBeam } from "@web/components/ui/border-beam"
import type { ReconstructionCopy } from "@web/content/types"
import { useHasMounted } from "@web/hooks/use-has-mounted"
import { useScriptedPhases } from "@web/hooks/use-scripted-phases"

interface HeroWorkbenchProps {
  copy: ReconstructionCopy
  /** The one description assistive technology gets, as for a screenshot. */
  alt: string
  caption: string
  className?: string
}

/**
 * How long each state of the thread holds, in milliseconds. The second gap is
 * the longest because the reply is being typed through it (about 2.2s at
 * 14ms a character), and the tool call should land once the sentence has.
 */
export const HERO_PHASE_DELAYS = [700, 2600, 900, 1100] as const

/**
 * The workbench on the first screen, running the site's one task in front of
 * the reader (spec 4.1, ADR-0092 8 as amended).
 *
 * The same reconstruction `ProductStage` renders elsewhere, driven forward
 * through its phases once the page has hydrated: request, reply, tool call,
 * diff, and then the halt on `Waiting for approval`. It runs once and stops
 * there. The halt is the argument, and a loop would keep undoing it.
 *
 * Three renders, each complete in its own terms:
 *
 *  - **Server and first client paint**: the opening state, request visible,
 *    dock showing the file it is about to change. Nothing essential is hidden
 *    behind hydration. The headline and the actions beside it are the page's
 *    content, and they are plain markup.
 *  - **Reduced motion**: the finished state, immediately. No sequence, not a
 *    faster one.
 *  - **Otherwise**: the sequence, starting the moment the page is interactive.
 *
 * The depicted interface is `aria-hidden` behind one `role="img"` and the alt
 * text, exactly as `ProductStage` does it: the rail entries and tabs are
 * pictures of controls, and the thread's text is the same demo copy the
 * signature section below carries in the accessibility tree already.
 */
export function HeroWorkbench({ copy, alt, caption, className }: HeroWorkbenchProps) {
  const reduced = useReducedMotion() ?? false
  const mounted = useHasMounted()
  const live = mounted && !reduced
  const phase = useScriptedPhases({ delays: HERO_PHASE_DELAYS, enabled: live })
  const shown = live ? phase : mounted ? WORKBENCH_COMPLETE : 0

  return (
    <figure className={className} data-placeholder="product-stage" data-phase={shown}>
      <div className="relative overflow-hidden rounded-stage">
        <div role="img" aria-label={alt}>
          <div aria-hidden>
            <WorkbenchReconstruction copy={copy} phase={shown} live={live} />
          </div>
        </div>
        <BorderBeam
          size={240}
          duration={12}
          borderWidth={1}
          colorFrom="var(--action)"
          colorTo="var(--hairline-strong)"
          transition={{ repeat: 1 }}
        />
      </div>
      <figcaption className="mt-3 flex flex-col gap-1 font-mono text-xs text-muted">
        <span>{caption}</span>
        <span>{copy.note}</span>
      </figcaption>
    </figure>
  )
}
