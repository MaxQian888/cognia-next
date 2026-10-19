"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { useReducedMotion } from "motion/react"
import { Icon, type IconName } from "@web/components/icon"
import { TaskArtifact } from "@web/components/product/task-artifact"
import { Section, SectionHeading } from "@web/components/section"
import { format } from "@web/content"
import type { ReconstructionCopy, SignatureCopy, SignatureStep, StepTone } from "@web/content/types"
import { usePinnedProgress } from "@web/hooks/use-pinned-progress"
import { useStepRail } from "@web/hooks/use-step-rail"
import { DemoActivityList } from "./demo-activity-list"
import { DemoFileTree } from "./demo-file-tree"

interface SignatureDemoProps {
  /** One-based position on the page, rendered as the heading index tag. */
  index?: number
  copy: SignatureCopy
  reconstruction: ReconstructionCopy
  fileTreeLabel?: string
  /**
   * Rendered under the demo, outside the pinned stage: the homepage passes
   * the links to the scenario pages, which carry this loop through a whole
   * piece of work. Built by the server and handed in, so the links need no
   * client code of their own.
   */
  footer?: ReactNode
  /**
   * The product film, rendered between the task and the steps: the section
   * tells the one task twice over — watch it, then step through it — instead
   * of a neighbouring section telling it a second time. Omitted when the film
   * has not been rendered.
   */
  film?: ReactNode
}

/** Index of the approval step — where autoplay stops and waits (spec §6.1). */
const APPROVAL_INDEX = 3

/**
 * One mark per step, keyed by the step id the content already carries.
 *
 * Presentation, not content — a translator has nothing to say about them — so
 * they live here rather than in `SiteCopy`, the same split
 * `capability-sections.tsx` makes. A step whose key is not listed simply
 * renders without one.
 */
const STEP_ICON: Record<string, IconName> = {
  context: "repository",
  plan: "workflow",
  action: "action",
  approval: "approval",
  test: "check",
  artifact: "artifact",
}

/**
 * Tone marks. Every state carries a glyph *and* its own words, so the meaning
 * never depends on colour alone (spec §8). `approval` is the only place amber
 * appears on the page.
 */
const TONE_MARK: Record<StepTone, string> = {
  ready: "◆",
  done: "✓",
  waiting: "!",
  pending: "·",
}

const TONE_CLASS: Record<StepTone, string> = {
  ready: "text-action",
  done: "text-success",
  waiting: "text-approval",
  pending: "text-on-stage-muted",
}

/**
 * One step: the argument on the left, the interface it is arguing about on the
 * right. The interface is the point — spec §4.2 lists the surfaces this section
 * has to show (repository context, plan, diff, permission checkpoint, check
 * output, artifact), and prose describing a diff is not a diff.
 */
function StepPanel({
  step,
  reconstruction,
  fileTreeLabel,
}: {
  step: SignatureStep
  reconstruction: ReconstructionCopy
  fileTreeLabel?: string
}) {
  const artifact =
    step.artifact === "context" && fileTreeLabel ? (
      <DemoFileTree ariaLabel={fileTreeLabel} copy={reconstruction.artifacts.context} />
    ) : step.artifact === "test" && fileTreeLabel ? (
      <DemoActivityList copy={reconstruction.artifacts.test} />
    ) : (
      <TaskArtifact kind={step.artifact} copy={reconstruction} />
    )

  return (
    <div className="signature-stage border-y border-on-stage-hairline bg-graphite">
      <div className="grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <div className="flex flex-col border-on-stage-hairline p-5 md:p-6 xl:border-r">
          <div className="flex items-center gap-2">
            {STEP_ICON[step.key] ? (
              <Icon name={STEP_ICON[step.key]} size={14} className={TONE_CLASS[step.tone]} />
            ) : null}
            <span aria-hidden className={`text-sm ${TONE_CLASS[step.tone]}`}>
              {TONE_MARK[step.tone]}
            </span>
            {/* The words read in ink; the tone rides on the mark and icon
             * beside them. Cyan is 1.69:1 on this substrate and the token's
             * own rule is that it is a line, a dot or a fill, never text. */}
            <span className="font-mono text-xs uppercase tracking-widest text-on-stage">
              {step.status}
            </span>
          </div>
          <h3 className="mt-4 text-balance text-2xl font-medium leading-snug text-on-stage md:text-3xl">
            {step.headline}
          </h3>
          <p className="mt-3 leading-relaxed text-on-stage-muted">{step.body}</p>
          <p className="mt-auto border-t border-on-stage-hairline pt-4 font-mono text-xs text-on-stage-muted">
            {step.detail}
          </p>
        </div>

        <div className="border-t border-on-stage-hairline p-5 md:p-6 xl:border-t-0">
          <div className="relative min-w-0">{artifact}</div>
        </div>
      </div>
    </div>
  )
}

/**
 * "One task. Every step visible." (spec §4.2, §6.3)
 *
 * The rail pins the task and its six states while the panel beside it changes.
 *
 * There are three modes, and each is a complete fallback for the one above it:
 *
 * 1. **Scroll-pinned** (spec §6.6, wide viewports only). The section holds the
 *    viewport and the reader's own scrolling advances the six steps. Native
 *    scrolling is never intercepted — see `usePinnedProgress`. Scroll position
 *    is the only source of truth here, so autoplay is off and the rail buttons
 *    scroll rather than set state; otherwise the rail and the page would drift
 *    apart the moment the reader touched the wheel.
 * 2. **Sticky rail with autoplay** (narrow viewports, and the server render).
 *    Autoplay stops on `Permission required` and stays there — a reader who
 *    looks away and back should find the page waiting on the human decision,
 *    which is the section's entire argument.
 * 3. **Static stepper** (`prefers-reduced-motion`). All six states rendered at
 *    once: no pinning, no scrubbing, no autoplay, same content, same order.
 *    Spec §6.3 requires this to be the absence of the effect, not a fast
 *    version of it.
 */
export function SignatureDemo({
  copy,
  reconstruction,
  fileTreeLabel,
  index,
  footer,
  film,
}: SignatureDemoProps) {
  const reduced = useReducedMotion() ?? false
  const rail = useStepRail({
    total: copy.steps.length,
    stopAt: APPROVAL_INDEX,
    reducedMotion: reduced,
  })
  // Destructured rather than kept as one `pin` object: a `pin.pinned` read in
  // JSX is a member access on a value that also carries `wrapperRef`, which the
  // compiler's lint rule cannot distinguish from a ref read during render.
  const {
    wrapperRef: pinWrapperRef,
    index: pinIndex,
    pinned,
    scrollToIndex,
  } = usePinnedProgress({ steps: copy.steps.length, enabled: !reduced })

  // While pinned, scroll position is the single source of truth: the rail's own
  // index would drift from the page the moment the reader scrolled. Autoplay is
  // likewise off — the reader is already driving.
  const activeIndex = pinned ? pinIndex : rail.index
  const active = copy.steps[activeIndex]

  // Below `lg` the rail is a horizontal strip that can be wider than the
  // screen; keep the current step in view as autoplay or the buttons move it.
  // Only the strip scrolls, never the page, so this cannot yank the reader.
  const railRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const list = railRef.current
    if (!list || list.scrollWidth <= list.clientWidth) return
    const item = list.children[activeIndex] as HTMLElement | undefined
    if (!item || typeof list.scrollTo !== "function") return
    list.scrollTo({
      left: item.offsetLeft - (list.clientWidth - item.offsetWidth) / 2,
      behavior: reduced ? "auto" : "smooth",
    })
  }, [activeIndex, reduced])

  return (
    <Section id="task" tone="surface">
      <SectionHeading
        index={index}
        eyebrow={copy.eyebrow}
        title={copy.title}
        subtitle={copy.subtitle}
      />

      <p className="mt-12 border-l-2 border-action pl-4 text-lg leading-relaxed text-ink md:text-xl">
        <span className="mr-3 font-mono text-xs uppercase tracking-widest text-muted">
          {copy.taskLabel}
        </span>
        {copy.task}
      </p>

      {film ? (
        <>
          <div className="mt-14">{film}</div>
          <p
            data-slot="steps-label"
            className="mt-16 border-t border-hairline pt-6 font-mono text-xs uppercase tracking-widest text-muted"
          >
            {copy.stepsLabel}
          </p>
        </>
      ) : null}

      {reduced ? (
        <ol className={`${film ? "mt-8" : "mt-14"} flex flex-col gap-6`}>
          {copy.steps.map((step) => (
            <li key={step.key}>
              <p className="mb-3 font-mono text-xs uppercase tracking-widest text-muted">
                {step.rail}
              </p>
              <StepPanel
                step={step}
                reconstruction={reconstruction}
                fileTreeLabel={fileTreeLabel}
              />
            </li>
          ))}
        </ol>
      ) : (
        <div
          ref={pinWrapperRef}
          // The travel the reader scrolls through while the panel below stays
          // put. Only present once pinning is live, so an unpinned page — the
          // server render, a narrow viewport, reduced motion — is exactly as
          // tall as its content.
          // 100dvh for the first step + 45dvh per subsequent step ≈ 325dvh total
          // for 6 steps. The panel still pins long enough to read each state,
          // without stranding the reader inside several mostly empty screens.
          style={
            pinned ? { height: `calc(100dvh + ${(copy.steps.length - 1) * 45}dvh)` } : undefined
          }
          className={film ? "mt-8" : "mt-14"}
        >
          <div
            data-pinned-viewport={pinned ? "" : undefined}
            className={pinned ? "sticky top-16 flex h-[calc(100dvh-4rem)] items-center py-6" : ""}
          >
            <div
              data-pinned-stage={pinned ? "" : undefined}
              className="grid w-full grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] lg:gap-10"
            >
              {/* Below `lg` the rail and its controls stick under the site bar
               * as one compact strip, so the step being shown and the panel
               * showing it stay on screen together. Stacked vertically they
               * took a full phone screen, and every change happened below the
               * fold where nobody could see it. */}
              <div
                className={
                  pinned
                    ? "flex min-h-0 flex-col"
                    : "sticky top-16 z-20 -mx-5 border-b border-hairline bg-surface/95 px-5 py-3 backdrop-blur-sm lg:top-28 lg:mx-0 lg:self-start lg:border-b-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none"
                }
              >
                <ol
                  ref={railRef}
                  aria-label={copy.stepperLabel}
                  className="relative flex gap-1 overflow-x-auto [scrollbar-width:none] lg:flex-col lg:gap-px lg:overflow-visible [&::-webkit-scrollbar]:hidden"
                >
                  {copy.steps.map((step, index) => {
                    const current = index === activeIndex
                    return (
                      <li key={step.key} className="shrink-0">
                        <button
                          type="button"
                          onClick={() => (pinned ? scrollToIndex(index) : rail.goTo(index))}
                          aria-current={current ? "step" : undefined}
                          className={`flex items-baseline gap-2 whitespace-nowrap border-b-2 px-2.5 py-2 text-left transition-colors lg:w-full lg:gap-3 lg:border-b-0 lg:border-l lg:px-0 lg:py-2.5 lg:pl-4 ${
                            current
                              ? "border-action text-ink"
                              : "border-hairline text-muted hover:text-ink"
                          }`}
                        >
                          {STEP_ICON[step.key] ? (
                            <Icon
                              name={STEP_ICON[step.key]}
                              size={14}
                              className={`max-lg:hidden ${current ? TONE_CLASS[step.tone] : ""}`}
                            />
                          ) : null}
                          <span aria-hidden className={`text-xs ${TONE_CLASS[step.tone]}`}>
                            {TONE_MARK[step.tone]}
                          </span>
                          <span className="font-mono text-xs uppercase tracking-widest">
                            {step.rail}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ol>

                <div className="mt-3 flex flex-wrap items-center gap-2 lg:mt-8">
                  <button
                    type="button"
                    onClick={() => (pinned ? scrollToIndex(activeIndex - 1) : rail.previous())}
                    disabled={activeIndex === 0}
                    className="inline-flex items-center gap-1.5 rounded-control border border-hairline-strong px-3 py-1.5 text-xs text-muted transition-colors hover:text-ink disabled:opacity-40"
                  >
                    <Icon name="previous" size={14} />
                    <span className="max-lg:sr-only">{copy.previousLabel}</span>
                  </button>
                  {/* Autoplay only exists when the reader is not already driving.
                   * A play button that fights the scroll position would be a
                   * control that visibly does nothing. */}
                  {pinned ? null : (
                    <button
                      type="button"
                      onClick={rail.toggle}
                      className="inline-flex items-center gap-1.5 rounded-control border border-hairline-strong px-3 py-1.5 text-xs text-muted transition-colors hover:text-ink"
                    >
                      <Icon name={rail.playing ? "pending" : "play"} size={14} />
                      {rail.playing ? copy.pauseLabel : copy.playLabel}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => (pinned ? scrollToIndex(activeIndex + 1) : rail.next())}
                    disabled={activeIndex === copy.steps.length - 1}
                    className="inline-flex items-center gap-1.5 rounded-control border border-hairline-strong px-3 py-1.5 text-xs text-muted transition-colors hover:text-ink disabled:opacity-40"
                  >
                    <span className="max-lg:sr-only">{copy.nextLabel}</span>
                    <Icon name="next" size={14} />
                  </button>

                  {/* Beside the controls on a phone, where vertical room is
                   * what the sticky strip costs; on its own line from `lg`. */}
                  <p
                    aria-live="polite"
                    className="ml-auto font-mono text-xs text-muted lg:ml-0 lg:mt-2 lg:basis-full"
                  >
                    {format(copy.stepOf, { current: activeIndex + 1, total: copy.steps.length })}
                  </p>
                </div>
              </div>

              {/* Keying on the step id restarts the fade-through, so the state
               * change is always accompanied by real content changing. */}
              <div
                key={active.key}
                className={`animate-[fade-through_320ms_ease-out] ${pinned ? "min-h-0" : ""}`}
              >
                <StepPanel
                  step={active}
                  reconstruction={reconstruction}
                  fileTreeLabel={fileTreeLabel}
                />
              </div>
            </div>
          </div>
        </div>
      )}
      {footer ? <div className="mt-12">{footer}</div> : null}
    </Section>
  )
}
