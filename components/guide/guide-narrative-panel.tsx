"use client"

import type { ReactNode } from "react"

import { GuideBrandMesh } from "./guide-brand-mesh"
import { GUIDE_COPY_ENTER, GUIDE_SCENE_ENTER } from "./guide-motion"
import { cn } from "@/lib/utils"

/**
 * How the panel behaves below `md`, where it stacks above the step body.
 *
 *  - `band`   — a height-capped band (~30vh) with the body scrolling beneath
 *               it. Right when the panel carries only a picture and a line.
 *  - `scroll` — no cap; the panel and the body share one page scroll. Right
 *               when the panel carries real material (the web pairing flow's
 *               command block), which a capped band would clip.
 *
 * At `md` and up both are the same full-height column with its own scroll.
 */
export type GuidePanelOverflow = "band" | "scroll"

export interface GuideNarrativePanelProps {
  /** The picture. Drawn by the caller, from live state. */
  scene: ReactNode
  /** Keys the scene's crossfade. */
  sceneKey: string
  /** One line saying what this moment is about. Already translated. */
  headline: string
  /** The supporting line. Already translated. */
  body?: string
  /** Keys the copy's crossfade; defaults to the headline itself. */
  copyKey?: string
  /** A live line about the far end — rendered under the copy. */
  status?: ReactNode
  /** Progress row. Rendered in its own band at the foot of the panel. */
  stepper?: ReactNode
  /** Material invariant across steps, under the stepper, left-aligned. */
  aside?: ReactNode
  overflow?: GuidePanelOverflow
  /** Prefix for `${prefix}-narrative-panel`, `-scene-slot`, `-narrative-*`. */
  testIdPrefix: string
}

/**
 * The narrative half of a full-window guide (ADR-0193, generalised from
 * ADR-0141's onboarding panel).
 *
 * A brand substrate, a scene drawn from live data, a headline and one line of
 * narration, and — where the flow has steps — the progress row. `/onboarding`
 * and `/pair` are the same kind of screen, a first-contact flow that owns the
 * window, and each used to build this panel by hand: different padding,
 * different scene sizes, a page title in one and a narrator's line in the
 * other. One panel is what makes them read as one product.
 *
 * **The headline is narration, not the page title.** Each step's body opens
 * with its own `GuideHeading` (the page's `h1`); the panel says what is
 * happening in the picture. Keeping the two roles apart is what lets the panel
 * stay put while the body changes underneath it.
 *
 * **Brand colour stays off the text layer.** `--brand-action` is 1.69:1 on a
 * light substrate, so it is a mesh and a stroke here, never a text colour.
 *
 * ```
 * md and up                          below md
 * ┌──────────────┬────────────┐      ┌──────────────────────┐
 * │  mesh        │            │      │ mesh · scene · line  │  band: ~30vh
 * │  ┌────────┐  │  step body │      ├──────────────────────┤
 * │  │ scene  │  │            │      │  step body           │
 * │  └────────┘  │            │      └──────────────────────┘
 * │  headline    │            │
 * │  one line    │            │
 * │  status      │            │
 * │  ─ stepper ─ │            │
 * │  aside       │            │
 * └──────────────┴────────────┘
 *    26rem / 30rem
 * ```
 */
export function GuideNarrativePanel({
  scene,
  sceneKey,
  headline,
  body,
  copyKey,
  status,
  stepper,
  aside,
  overflow = "band",
  testIdPrefix,
}: GuideNarrativePanelProps) {
  const band = overflow === "band"

  return (
    <aside
      data-testid={`${testIdPrefix}-narrative-panel`}
      data-overflow={overflow}
      className={cn(
        "relative flex w-full shrink-0 flex-col border-b border-border/60",
        band
          ? // Bounded so a short viewport still leaves the step body usable.
            "h-[30vh] max-h-[15rem] min-h-[9.5rem] overflow-hidden"
          : "",
        // Wide: a full-height column with a hairline trailing edge and a
        // scroll of its own, so a long aside never pushes the body away.
        "md:h-auto md:max-h-none md:w-[26rem] md:overflow-y-auto md:border-r md:border-b-0 lg:w-[30rem]"
      )}
    >
      <GuideBrandMesh />

      {/* `justify-center-safe`: centred when it fits, top-aligned when the
          panel overflows — plain centring would clip the top unreachably.
          Only the capped band may squeeze this block (its scene shrinks to
          fit); everywhere else it keeps its content height and the panel
          scrolls, or a long aside pushes the copy under the stepper. */}
      <div
        className={cn(
          "relative flex flex-1 flex-col items-center justify-center-safe gap-4 px-6 py-5 md:gap-7 md:px-10 md:py-12",
          band && "min-h-0 md:min-h-auto"
        )}
      >
        <div
          key={sceneKey}
          data-testid={`${testIdPrefix}-scene-slot`}
          className={cn(
            "flex w-full items-center justify-center md:max-w-[20rem] md:flex-none",
            // The band is height-capped, so the scene may flex down inside it;
            // the page-scrolling panel is not, so the scene gets a width cap
            // instead — a picture sized for the column would take half a phone
            // screen to say what the line under it already says.
            band ? "min-h-0 max-w-[15rem] flex-1" : "max-w-[8.5rem]",
            GUIDE_SCENE_ENTER
          )}
        >
          {scene}
        </div>

        <div
          key={`${copyKey ?? headline}-copy`}
          className={cn(
            "flex w-full flex-col items-center gap-1.5 text-center md:gap-2",
            GUIDE_COPY_ENTER
          )}
        >
          <p
            className="text-balance text-sm font-medium tracking-tight text-foreground md:text-base"
            data-testid={`${testIdPrefix}-narrative-headline`}
          >
            {headline}
          </p>
          {body && (
            <p
              className={cn(
                "max-w-[34ch] text-balance text-xs leading-relaxed text-muted-foreground md:text-sm",
                // The supporting line is the first thing to go when the band
                // is short — on a 375×667 phone it would push the scene out.
                band && "hidden sm:block"
              )}
              data-testid={`${testIdPrefix}-narrative-body`}
            >
              {body}
            </p>
          )}
        </div>

        {status && <div className="flex w-full justify-center">{status}</div>}
      </div>

      {stepper && (
        <div className="relative flex shrink-0 justify-center px-6 pb-5 md:px-10 md:pb-10">
          {stepper}
        </div>
      )}

      {aside && (
        <div className="relative flex shrink-0 flex-col gap-3 px-6 pb-6 md:px-10 md:pb-10">
          {aside}
        </div>
      )}
    </aside>
  )
}
