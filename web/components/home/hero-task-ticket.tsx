import { Icon, type IconName } from "@web/components/icon"
import { DEMO_TASK } from "@web/content/demo-task"
import type { HeroTicketCopy, ReconstructionCopy } from "@web/content/types"
import { cn } from "@web/lib/utils"

interface HeroTaskTicketProps {
  copy: HeroTicketCopy
  reconstruction: ReconstructionCopy
  className?: string
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
 * The signature task, stated as a ticket, beneath the hero's live workbench.
 *
 * Every value here already exists elsewhere on the page: the repository, branch
 * and failing check come from `DEMO_TASK`, and the plan rows and status line
 * come from the same `reconstruction` copy the workbench renders. The ticket
 * therefore introduces **no new factual claim**. It reads as the status strip
 * of the workbench above it: identity on the left, the plan and where it has
 * got to on the right.
 *
 * The states are marked with a glyph *and* a word, never colour alone (spec 8).
 */
export function HeroTaskTicket({ copy, reconstruction, className }: HeroTaskTicketProps) {
  const { plan } = reconstruction.artifacts

  const rows = [
    { key: "repository", label: copy.repositoryLabel, value: DEMO_TASK.repository },
    { key: "branch", label: copy.branchLabel, value: DEMO_TASK.branch },
    { key: "check", label: copy.checkLabel, value: DEMO_TASK.check },
  ]

  return (
    <div
      className={cn(
        "grid gap-px border-y border-hairline bg-hairline lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]",
        className
      )}
    >
      <div className="bg-paper py-5 lg:pr-10">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">{copy.label}</p>
        <dl className="mt-4 flex flex-col gap-px bg-hairline">
          {rows.map((row) => (
            <div
              key={row.key}
              className="flex items-baseline justify-between gap-4 bg-paper py-2.5"
            >
              <dt className="font-mono text-[10px] uppercase tracking-widest text-muted">
                {row.label}
              </dt>
              <dd className="truncate font-mono text-xs text-ink">{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="bg-paper py-5 lg:pl-10">
        <div className="flex items-baseline justify-between gap-4">
          <p className="font-mono text-xs uppercase tracking-widest text-muted">{copy.planLabel}</p>
          <p className="flex items-center gap-2">
            <Icon name="alert" size={14} className="text-approval" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted">
              {copy.stateLabel}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink">
              {reconstruction.workbench.statusLine}
            </span>
          </p>
        </div>
        <ul className="mt-4 grid gap-x-8 gap-y-2 md:grid-cols-2">
          {DEMO_TASK.plan.map((item) => {
            const entry = plan.items[item.key]
            return (
              <li key={item.key} className="flex items-start gap-2.5 text-sm leading-relaxed">
                <Icon
                  name={PLAN_STATE_ICON[entry.state]}
                  size={14}
                  className={cn("mt-1 shrink-0", PLAN_STATE_CLASS[entry.state])}
                />
                <span className="min-w-0 flex-1 text-ink">{entry.text}</span>
                {/* The state in words as well as in the glyph. */}
                <span className="ml-2 shrink-0 font-mono text-[10px] uppercase tracking-widest text-muted">
                  {plan.stateLabels[entry.state]}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
