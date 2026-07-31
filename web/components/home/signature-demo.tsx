"use client"

import { useReducedMotion } from "motion/react"
import { Icon, type IconName } from "@web/components/icon"
import { TaskArtifact } from "@web/components/product/task-artifact"
import { Section, SectionHeading } from "@web/components/section"
import { format } from "@web/content"
import type { ReconstructionCopy, SignatureCopy, SignatureStep, StepTone } from "@web/content/types"
import { usePinnedProgress } from "@web/hooks/use-pinned-progress"
import { useStepRail } from "@web/hooks/use-step-rail"

interface SignatureDemoProps {
  copy: SignatureCopy
  reconstruction: ReconstructionCopy
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
  /**
   * Stretch to the height the parent offers instead of hugging the content.
   *
   * Only the pinned mode passes this. Pinned, the panel owns a whole screen,
   * and a content-height panel left roughly a third of it empty — measured at
   * 1512×900, 506px of content against 804px of available viewport. Unpinned,
   * the panel sits in normal page flow and stretching it would invent
   * whitespace instead of removing it.
   */
  fill = false,
}: {
  step: SignatureStep
  reconstruction: ReconstructionCopy
  fill?: boolean
}) {
  return (
    <div
      className={`overflow-hidden rounded-stage border border-on-stage-hairline bg-graphite ${
        fill ? "flex h-full min-h-0 flex-col" : ""
      }`}
    >
      <div
        className={`grid xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] ${
          fill ? "min-h-0 flex-1" : ""
        }`}
      >
        <div
          className={`flex flex-col border-on-stage-hairline p-6 md:p-8 xl:border-r ${
            fill ? "min-h-0" : ""
          }`}
        >
          <div className="flex items-center gap-2">
            {STEP_ICON[step.key] ? (
              <Icon name={STEP_ICON[step.key]} size={14} className={TONE_CLASS[step.tone]} />
            ) : null}
            <span aria-hidden className={`text-sm ${TONE_CLASS[step.tone]}`}>
              {TONE_MARK[step.tone]}
            </span>
            <span
              className={`font-mono text-xs uppercase tracking-widest ${TONE_CLASS[step.tone]}`}
            >
              {step.status}
            </span>
          </div>
          <h3 className="mt-5 text-balance text-2xl font-medium leading-snug text-on-stage md:text-3xl">
            {step.headline}
          </h3>
          <p className="mt-4 leading-relaxed text-on-stage-muted">{step.body}</p>
          <p
            className={`border-t border-on-stage-hairline pt-4 font-mono text-xs text-on-stage-muted ${
              // Pinned, the detail line sits on the panel's floor rather than
              // wherever the body happens to end, so the two columns share one
              // baseline at every step regardless of how long the body runs.
              fill ? "mt-auto" : "mt-8"
            }`}
          >
            {step.detail}
          </p>
        </div>

        <div
          className={`border-t border-on-stage-hairline p-6 md:p-8 xl:border-t-0 ${
            // The artifact is the tallest thing here and the one most likely to
            // outgrow a short window, so it is what scrolls — never the page,
            // which is already driving the pin.
            fill ? "min-h-0 overflow-y-auto" : ""
          }`}
        >
          <TaskArtifact kind={step.artifact} copy={reconstruction} />
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
export function SignatureDemo({ copy, reconstruction }: SignatureDemoProps) {
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

  return (
    <Section id="task" tone="stage">
      <SectionHeading
        eyebrow={copy.eyebrow}
        title={copy.title}
        subtitle={copy.subtitle}
        tone="stage"
      />

      <p className="mt-12 border-l-2 border-action pl-4 text-lg leading-relaxed text-on-stage md:text-xl">
        <span className="mr-3 font-mono text-xs uppercase tracking-widest text-on-stage-muted">
          {copy.taskLabel}
        </span>
        {copy.task}
      </p>

      {reduced ? (
        <ol className="mt-14 flex flex-col gap-6">
          {copy.steps.map((step) => (
            <li key={step.key}>
              <p className="mb-3 font-mono text-xs uppercase tracking-widest text-on-stage-muted">
                {step.rail}
              </p>
              <StepPanel step={step} reconstruction={reconstruction} />
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
          style={pinned ? { height: `${copy.steps.length * 100}vh` } : undefined}
          className="mt-14"
        >
          <div
            className={`grid gap-10 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:gap-16 ${
              // `dvh`, not `vh`: on a browser whose chrome hides on scroll,
              // `vh` is the *largest* viewport and the panel would be cropped
              // by exactly the chrome's height for the whole scroll. `dvh`
              // tracks the real one. The offset clears the 64px sticky nav.
              pinned ? "sticky top-20 h-[calc(100dvh-5rem)] items-stretch pb-6" : ""
            }`}
          >
            <div className={pinned ? "flex min-h-0 flex-col" : "lg:sticky lg:top-28 lg:self-start"}>
              <ol aria-label={copy.stepperLabel} className="flex flex-col gap-px">
                {copy.steps.map((step, index) => {
                  const current = index === activeIndex
                  return (
                    <li key={step.key}>
                      <button
                        type="button"
                        onClick={() => (pinned ? scrollToIndex(index) : rail.goTo(index))}
                        aria-current={current ? "step" : undefined}
                        className={`flex w-full items-baseline gap-3 border-l py-2.5 pl-4 text-left transition-colors ${
                          current
                            ? "border-action text-on-stage"
                            : "border-on-stage-hairline text-on-stage-muted hover:text-on-stage"
                        }`}
                      >
                        {STEP_ICON[step.key] ? (
                          <Icon
                            name={STEP_ICON[step.key]}
                            size={14}
                            className={current ? TONE_CLASS[step.tone] : undefined}
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

              <div className="mt-8 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => (pinned ? scrollToIndex(activeIndex - 1) : rail.previous())}
                  disabled={activeIndex === 0}
                  className="inline-flex items-center gap-1.5 rounded-control border border-on-stage-hairline px-3 py-1.5 text-xs text-on-stage-muted transition-colors hover:text-on-stage disabled:opacity-40"
                >
                  <Icon name="previous" size={14} />
                  {copy.previousLabel}
                </button>
                {/* Autoplay only exists when the reader is not already driving.
                 * A play button that fights the scroll position would be a
                 * control that visibly does nothing. */}
                {pinned ? null : (
                  <button
                    type="button"
                    onClick={rail.toggle}
                    className="inline-flex items-center gap-1.5 rounded-control border border-on-stage-hairline px-3 py-1.5 text-xs text-on-stage-muted transition-colors hover:text-on-stage"
                  >
                    <Icon name={rail.playing ? "pending" : "play"} size={14} />
                    {rail.playing ? copy.pauseLabel : copy.playLabel}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => (pinned ? scrollToIndex(activeIndex + 1) : rail.next())}
                  disabled={activeIndex === copy.steps.length - 1}
                  className="inline-flex items-center gap-1.5 rounded-control border border-on-stage-hairline px-3 py-1.5 text-xs text-on-stage-muted transition-colors hover:text-on-stage disabled:opacity-40"
                >
                  {copy.nextLabel}
                  <Icon name="next" size={14} />
                </button>
              </div>

              <p aria-live="polite" className="mt-4 font-mono text-xs text-on-stage-muted">
                {format(copy.stepOf, { current: activeIndex + 1, total: copy.steps.length })}
              </p>

              {/* Pinned, the section owns the screen and the page heading above
               * has scrolled away — so the one task the whole site follows
               * (spec §9) is restated here, on the rail's floor, and stays in
               * view for all six steps. It also gives the rail column something
               * to fill the height with other than air. */}
              {pinned ? (
                <div className="mt-auto border-t border-on-stage-hairline pt-6">
                  <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-on-stage-muted">
                    <Icon name="agents" size={14} />
                    {copy.taskLabel}
                  </p>
                  <p className="mt-3 border-l-2 border-action pl-3 text-sm leading-relaxed text-on-stage">
                    {copy.task}
                  </p>
                </div>
              ) : null}
            </div>

            {/* Keying on the step id restarts the fade-through, so the state
             * change is always accompanied by real content changing. */}
            <div
              key={active.key}
              className={`animate-[fade-through_320ms_ease-out] ${pinned ? "min-h-0" : ""}`}
            >
              <StepPanel step={active} reconstruction={reconstruction} fill={pinned} />
            </div>
          </div>
        </div>
      )}
    </Section>
  )
}
