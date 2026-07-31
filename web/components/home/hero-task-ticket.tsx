import { Icon, type IconName } from "@web/components/icon"
import { DEMO_TASK } from "@web/content/demo-task"
import type { HeroTicketCopy, ReconstructionCopy } from "@web/content/types"
import { cn } from "@web/lib/utils"

interface HeroTaskTicketProps {
  copy: HeroTicketCopy
  reconstruction: ReconstructionCopy
}

const PLAN_STATE_ICON = {
  done: "check",
  active: "action",
  todo: "pending",
} as const satisfies Record<string, IconName>

const PLAN_STATE_CLASS = {
  done: "text-success",
  active: "text-action",
  todo: "text-stone",
} as const

/**
 * The signature task, stated as a ticket, beside the hero's headline.
 *
 * Every value here already exists elsewhere on the page: the repository, branch
 * and failing check come from `DEMO_TASK`, and the plan rows and status line
 * come from the same `reconstruction` copy the workbench below renders. The
 * ticket therefore introduces **no new factual claim** — it moves the page's
 * argument ("one task, every step visible") onto the first screen instead of
 * making the reader scroll nine hundred pixels to meet it.
 *
 * The states are marked with a glyph *and* a word, never colour alone (spec §8).
 */
export function HeroTaskTicket({ copy, reconstruction }: HeroTaskTicketProps) {
  const { plan } = reconstruction.artifacts

  const rows = [
    { key: "repository", label: copy.repositoryLabel, value: DEMO_TASK.repository },
    { key: "branch", label: copy.branchLabel, value: DEMO_TASK.branch },
    { key: "check", label: copy.checkLabel, value: DEMO_TASK.check },
  ]

  return (
    <div className="border-hairline lg:border-l lg:pl-14">
      <p className="font-mono text-xs uppercase tracking-widest text-muted">{copy.label}</p>

      <dl className="mt-6 flex flex-col gap-px bg-hairline">
        {rows.map((row) => (
          <div key={row.key} className="flex items-baseline justify-between gap-4 bg-paper py-3">
            <dt className="font-mono text-[10px] uppercase tracking-widest text-muted">
              {row.label}
            </dt>
            <dd className="truncate font-mono text-xs text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-8 font-mono text-[10px] uppercase tracking-widest text-muted">
        {copy.planLabel}
      </p>
      <ul className="mt-4 flex flex-col gap-2.5">
        {DEMO_TASK.plan.map((item) => {
          const entry = plan.items[item.key]
          return (
            <li key={item.key} className="flex items-start gap-2.5 text-sm leading-relaxed">
              <Icon
                name={PLAN_STATE_ICON[entry.state]}
                size={14}
                className={cn("mt-1", PLAN_STATE_CLASS[entry.state])}
              />
              <span className="text-ink">{entry.text}</span>
              {/* The state in words as well as in the glyph. */}
              <span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-widest text-muted">
                {plan.stateLabels[entry.state]}
              </span>
            </li>
          )
        })}
      </ul>

      <div className="mt-8 flex items-center gap-2 border-t border-hairline pt-4">
        <Icon name="alert" size={14} className="text-approval" />
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
          {copy.stateLabel}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink">
          {reconstruction.workbench.statusLine}
        </span>
      </div>
    </div>
  )
}
