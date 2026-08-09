import { Hairline } from "@web/components/hairline"
import { Reveal } from "@web/components/reveal"
import { Section, SectionHeading } from "@web/components/section"
import { BentoGrid } from "@web/components/ui/bento-grid"
import { DEMO_TASK } from "@web/content/demo-task"
import type { CommonCopy, ReconstructionCopy, WorkbenchCopy } from "@web/content/types"

interface WorkbenchBentoProps {
  copy: WorkbenchCopy
  common: CommonCopy
  reconstruction: ReconstructionCopy
}

/** Mono detail lines: the same task's real paths, tools and states. */
function Detail({ lines, tone = "muted" }: { lines: string[]; tone?: "muted" | "ink" }) {
  return (
    <ul className="mt-4 flex flex-col gap-1.5">
      {lines.map((line) => (
        <li
          key={line}
          className={`truncate font-mono text-[10px] ${tone === "ink" ? "text-ink" : "text-muted"}`}
        >
          {line}
        </li>
      ))}
    </ul>
  )
}

/**
 * "Everything the task needs, in one workbench." (spec §4.3)
 *
 * A gapless bento, not five feature cards: the panels share hairline borders so
 * they read as regions of one surface. That is the argument — these are not
 * separate products with a shared login.
 *
 * Every region shows a fragment of the *same* signature task, taken from the
 * shared fixture rather than written per panel, so the claim that they read and
 * write one working context is visible in the panels instead of only asserted
 * above them.
 *
 * The context path is a cyan rule across the grid with a station dot on each
 * region. It is decorative — the borders and the copy carry the meaning — so it
 * is hidden from assistive technology and described by one screen-reader
 * sentence instead.
 */
export function WorkbenchBento({ copy, common, reconstruction }: WorkbenchBentoProps) {
  const [task, chat, artifact, workflow, knowledge, plugins] = copy.panels
  const { workbench, artifacts } = reconstruction
  const tools = DEMO_TASK.plan.map((step) => step.tool)

  const cell = "relative bg-surface p-6 md:p-8 flex flex-col min-h-40 lg:min-h-48 min-w-0"
  const label = "flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-muted"
  const body = "mt-4 text-sm leading-relaxed text-ink"
  const station = <span aria-hidden className="size-1 shrink-0 rounded-full bg-action" />

  return (
    <Section id="workbench" tone="paper" density="open">
      <SectionHeading eyebrow={copy.eyebrow} title={copy.title} subtitle={copy.subtitle} />

      <Reveal className="mt-14">
        <div className="relative border-y border-hairline">
          <span className="sr-only">{common.contextPathLabel}</span>
          {/* Drawn, not painted. A cyan rule threading six regions is the one
           * place on the page where the motion *is* the argument — the shared
           * context arriving across the workbench — so it earns the Draw
           * vocabulary rather than sitting there as a static line. */}
          <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 hidden lg:block">
            <Hairline tone="action" className="opacity-60" />
          </div>

          <BentoGrid className="lg:grid-cols-4">
            <div className={cell}>
              <p className={label}>
                {station}
                {chat.label}
              </p>
              <p className={body}>{chat.body}</p>
              <Detail
                lines={[`${workbench.youLabel} · ${workbench.agentLabel}`, DEMO_TASK.repository]}
              />
            </div>

            {/* The hub. On `paper` rather than `surface` so the region the others
             * feed reads as the centre without a shadow or a border of its own. */}
            <div className={`${cell} bg-paper lg:col-span-2 lg:row-span-2`}>
              <p className={label}>
                {station}
                {task.label}
              </p>
              <p className="mt-4 text-base leading-relaxed text-ink lg:text-lg">{task.body}</p>
              <ul className="mt-6 flex flex-col gap-2 border-t border-hairline pt-5">
                {DEMO_TASK.plan.map((step) => {
                  const item = artifacts.plan.items[step.key]
                  return (
                    <li key={step.key} className="flex items-baseline gap-3">
                      <span className="w-20 shrink-0 font-mono text-[10px] uppercase tracking-widest text-muted">
                        {artifacts.plan.stateLabels[item.state]}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-ink">{item.text}</span>
                    </li>
                  )
                })}
              </ul>
            </div>

            <div className={cell}>
              <p className={label}>
                {station}
                {workflow.label}
              </p>
              <p className={body}>{workflow.body}</p>
              <Detail lines={[tools.join(" → ")]} />
            </div>

            <div className={cell}>
              <p className={label}>
                {station}
                {knowledge.label}
              </p>
              <p className={body}>{knowledge.body}</p>
              <Detail lines={DEMO_TASK.files.map((file) => file.path)} />
            </div>

            <div className={cell}>
              <p className={label}>
                {station}
                {plugins.label}
              </p>
              <p className={body}>{plugins.body}</p>
              <Detail lines={[DEMO_TASK.approval.command, DEMO_TASK.test.command]} />
            </div>

            <div className={`${cell} lg:col-span-4`}>
              <p className={label}>
                {station}
                {artifact.label}
              </p>
              <p className={body}>{artifact.body}</p>
              <Detail
                tone="ink"
                lines={[`${DEMO_TASK.artifact.file} · ${DEMO_TASK.artifact.version}`]}
              />
            </div>
          </BentoGrid>
        </div>
      </Reveal>
    </Section>
  )
}
