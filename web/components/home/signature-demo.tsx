"use client"

import { useReducedMotion } from "motion/react"
import { TaskArtifact } from "@web/components/product/task-artifact"
import { Section, SectionHeading } from "@web/components/section"
import { format } from "@web/content"
import type { ReconstructionCopy, SignatureCopy, SignatureStep, StepTone } from "@web/content/types"
import { useStepRail } from "@web/hooks/use-step-rail"

interface SignatureDemoProps {
  copy: SignatureCopy
  reconstruction: ReconstructionCopy
}

/** Index of the approval step — where autoplay stops and waits (spec §6.1). */
const APPROVAL_INDEX = 3

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
}: {
  step: SignatureStep
  reconstruction: ReconstructionCopy
}) {
  return (
    <div className="overflow-hidden rounded-stage border border-on-stage-hairline bg-graphite">
      <div className="grid xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="border-on-stage-hairline p-6 md:p-8 xl:border-r">
          <div className="flex items-center gap-2">
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
          <p className="mt-8 border-t border-on-stage-hairline pt-4 font-mono text-xs text-on-stage-muted">
            {step.detail}
          </p>
        </div>

        <div className="border-t border-on-stage-hairline p-6 md:p-8 xl:border-t-0">
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
 * Autoplay stops on `Permission required` and stays there — a reader who looks
 * away and back should find the page waiting on the human decision, which is
 * the section's entire argument.
 *
 * Under reduced motion the whole thing becomes a static stepper with all six
 * states rendered at once: no pinning, no scrubbing, no autoplay, and the same
 * content in the same order.
 */
export function SignatureDemo({ copy, reconstruction }: SignatureDemoProps) {
  const reduced = useReducedMotion() ?? false
  const rail = useStepRail({
    total: copy.steps.length,
    stopAt: APPROVAL_INDEX,
    reducedMotion: reduced,
  })
  const active = copy.steps[rail.index]

  return (
    <Section tone="stage">
      <SectionHeading title={copy.title} subtitle={copy.subtitle} tone="stage" />

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
        <div className="mt-14 grid gap-10 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:gap-16">
          <div className="lg:sticky lg:top-28 lg:self-start">
            <ol aria-label={copy.stepperLabel} className="flex flex-col gap-px">
              {copy.steps.map((step, index) => {
                const current = index === rail.index
                return (
                  <li key={step.key}>
                    <button
                      type="button"
                      onClick={() => rail.goTo(index)}
                      aria-current={current ? "step" : undefined}
                      className={`flex w-full items-baseline gap-3 border-l py-2.5 pl-4 text-left transition-colors ${
                        current
                          ? "border-action text-on-stage"
                          : "border-on-stage-hairline text-on-stage-muted hover:text-on-stage"
                      }`}
                    >
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
                onClick={rail.previous}
                disabled={rail.atStart}
                className="rounded-control border border-on-stage-hairline px-3 py-1.5 text-xs text-on-stage-muted transition-colors hover:text-on-stage disabled:opacity-40"
              >
                {copy.previousLabel}
              </button>
              <button
                type="button"
                onClick={rail.toggle}
                className="rounded-control border border-on-stage-hairline px-3 py-1.5 text-xs text-on-stage-muted transition-colors hover:text-on-stage"
              >
                {rail.playing ? copy.pauseLabel : copy.playLabel}
              </button>
              <button
                type="button"
                onClick={rail.next}
                disabled={rail.atEnd}
                className="rounded-control border border-on-stage-hairline px-3 py-1.5 text-xs text-on-stage-muted transition-colors hover:text-on-stage disabled:opacity-40"
              >
                {copy.nextLabel}
              </button>
            </div>

            <p aria-live="polite" className="mt-4 font-mono text-xs text-on-stage-muted">
              {format(copy.stepOf, { current: rail.index + 1, total: copy.steps.length })}
            </p>
          </div>

          {/* Keying on the step id restarts the fade-through, so the state
           * change is always accompanied by real content changing. */}
          <div key={active.key} className="animate-[fade-through_320ms_ease-out]">
            <StepPanel step={active} reconstruction={reconstruction} />
          </div>
        </div>
      )}
    </Section>
  )
}
