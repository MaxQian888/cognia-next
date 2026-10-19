import { AppFrame, PaneHeading } from "@web/components/product/app-frame"
import { Icon } from "@web/components/icon"
import { DEMO_TASK } from "@web/content/demo-task"
import type { ReconstructionCopy } from "@web/content/types"

interface AgentRosterReconstructionProps {
  copy: ReconstructionCopy
  className?: string
}

type MemberState = "waiting" | "done" | "running" | "queued"

/**
 * Each member's state and tools, in roster order. Presentation joined to the
 * localised roster by position, the same way the copy is ordered; the tools
 * are the ones the signature task's plan already names for that step, so the
 * team is the same work the rest of the site follows, split four ways.
 */
export const ROSTER: Array<{ state: MemberState; tools: readonly string[] }> = [
  { state: "waiting", tools: [DEMO_TASK.approval.command] },
  { state: "done", tools: [DEMO_TASK.plan[1].tool] },
  { state: "running", tools: [DEMO_TASK.plan[2].tool] },
  { state: "queued", tools: [DEMO_TASK.plan[3].tool] },
]

/**
 * The agent team on the signature task, rebuilt for /product#agents.
 *
 * A lead and three teammates, each with only the tools its step needs, and one
 * review gate in front of the push. The lead's row is the one waiting for a
 * person, so it is the one place amber appears (The Meaningful Amber Rule).
 */
export function AgentRosterReconstruction({ copy, className }: AgentRosterReconstructionProps) {
  const { agents } = copy
  return (
    <AppFrame
      title={DEMO_TASK.repository}
      meta={`${agents.teamLabel} · ${DEMO_TASK.branch}`}
      label={copy.label}
      className={className}
    >
      <ul className="flex flex-col bg-surface">
        {agents.members.map((member, position) => {
          const roster = ROSTER[position] ?? { state: "queued" as const, tools: [] }
          return (
            <li
              key={member.name}
              data-member-state={roster.state}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2 border-t border-hairline px-5 py-4 first:border-t-0"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className="flex items-center gap-2">
                  <span className="text-sm font-medium text-ink">{member.name}</span>
                  {position === 0 ? (
                    <span className="rounded-control border border-hairline-strong px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted">
                      {agents.leadLabel}
                    </span>
                  ) : null}
                </p>
                <p className="text-sm text-muted">{member.role}</p>
              </div>
              <StateMark state={roster.state} label={member.state} />
              <div className="col-span-2 flex items-center gap-2">
                <PaneHeading>{agents.toolsLabel}</PaneHeading>
                {roster.tools.map((tool) => (
                  <span
                    key={tool}
                    className="rounded-control border border-hairline bg-paper px-2 py-0.5 font-mono text-xs text-ink"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </li>
          )
        })}
      </ul>
      <div className="flex items-start gap-3 border-t border-hairline bg-paper px-5 py-4">
        <Icon name="approval" size={16} className="mt-0.5 shrink-0 text-approval" />
        <div className="flex flex-col gap-1">
          <PaneHeading>{agents.reviewLabel}</PaneHeading>
          <p className="text-sm leading-relaxed text-ink">{agents.reviewBody}</p>
        </div>
      </div>
    </AppFrame>
  )
}

function StateMark({ state, label }: { state: MemberState; label: string }) {
  const mark =
    state === "done" ? (
      <Icon name="check" size={14} className="text-success" />
    ) : state === "waiting" ? (
      <span className="size-2 rounded-full bg-approval" />
    ) : state === "running" ? (
      <span className="size-2 rounded-full bg-action" />
    ) : (
      <span className="size-2 rounded-full border border-hairline-strong" />
    )
  return (
    <p className="flex items-center gap-2 font-mono text-xs text-ink">
      <span aria-hidden className="flex size-3.5 items-center justify-center">
        {mark}
      </span>
      {label}
    </p>
  )
}
