import { AppFrame, PaneHeading } from "@web/components/product/app-frame"
import { DiffView } from "@web/components/product/diff-view"
import { TypingAnimation } from "@web/components/ui/terminal"
import { DEMO_TASK } from "@web/content/demo-task"
import type { ReconstructionCopy } from "@web/content/types"

/**
 * The states the thread passes through when it is shown building itself up.
 *
 *  0  the request
 *  1  the agent's reply, typed when live
 *  2  the tool call it made
 *  3  the diff landing in the dock
 *  4  work paused on `Waiting for approval`
 *
 * `WORKBENCH_COMPLETE` is the default: a static rendering shows the finished
 * state, which is also what reduced motion gets.
 */
export const WORKBENCH_PHASES = ["request", "reply", "tool", "diff", "approval"] as const
export const WORKBENCH_COMPLETE = WORKBENCH_PHASES.length - 1

interface WorkbenchReconstructionProps {
  copy: ReconstructionCopy
  /** How far the thread has got. Defaults to the finished state. */
  phase?: number
  /**
   * Types the agent's reply and lets each later turn fade in. Only meaningful while
   * `phase` is being driven forward by a caller. Never set under reduced
   * motion: the caller decides that, so this component stays free of the
   * motion hook and renderable on the server.
   */
  live?: boolean
  className?: string
}

/** Fade-through for a turn arriving in the live thread. */
const ARRIVE = "animate-[fade-through_320ms_ease-out_both]"

/**
 * The Cognia workbench, rebuilt in DOM (ADR-0092 8, amended).
 *
 * Three regions, in the shipping arrangement: the activity rail, the thread that
 * carries the task, and the workspace dock holding what the task produced. The
 * chrome sits on the light product surface and the diff sits on the graphite
 * execution substrate, the light-reading / dark-execution split the spec asks
 * for (2.1), inside one frame rather than across two sections.
 *
 * It stops on `Waiting for approval` (spec 6.1) because that is the state the
 * page argues about: work paused on a human decision, not a spinner.
 *
 * Inside a `.stage-scope` region the same markup renders on the dark stage,
 * because the scope remaps the reading tokens this component is written in.
 */
export function WorkbenchReconstruction({
  copy,
  phase = WORKBENCH_COMPLETE,
  live = false,
  className,
}: WorkbenchReconstructionProps) {
  const { workbench } = copy
  const reached = (step: number) => phase >= step

  return (
    <AppFrame
      title={DEMO_TASK.repository}
      meta={`${workbench.branchLabel} ${DEMO_TASK.branch}`}
      label={copy.label}
      className={className}
    >
      {/* The stage runs near full width (spec 4.1), so it needs height to read
       * as a workspace rather than as a letterboxed strip. */}
      <div className="grid lg:min-h-96 lg:grid-cols-[7rem_minmax(0,1fr)_minmax(0,22rem)]">
        {/* Activity rail. Horizontal on narrow widths, where a vertical rail
         * would eat the measure the thread needs.
         *
         * A list, not a `<nav>`: this is a picture of the rail. A real landmark
         * here would add a second navigation region to the page for something a
         * reader cannot navigate with. */}
        {/* Separators are per-item borders rather than a `gap-px` over a tinted
         * track: in column mode the track's leftover height below the last entry
         * would show through as a grey slab. */}
        <ul className="flex overflow-hidden border-b border-hairline bg-surface lg:flex-col lg:border-b-0 lg:border-r">
          {DEMO_TASK.rail.map((key) => {
            const active = key === "chat"
            return (
              <li
                key={key}
                className={`flex-1 truncate border-r border-r-hairline px-2 py-3 text-center font-mono text-[10px] uppercase tracking-widest last:border-r-0 lg:flex-none lg:border-r-0 lg:border-b lg:border-b-hairline lg:border-l-2 lg:text-left lg:last:border-b-0 ${
                  active
                    ? "text-ink lg:border-l-action lg:bg-paper"
                    : "text-muted lg:border-l-transparent"
                }`}
              >
                {workbench.rail[key]}
              </li>
            )
          })}
        </ul>

        <div className="flex flex-col gap-5 border-hairline p-5 lg:border-r lg:p-6">
          <PaneHeading>{workbench.threadLabel}</PaneHeading>

          <div className="border-l-2 border-hairline-strong pl-4">
            <PaneHeading className="mb-1.5">{workbench.youLabel}</PaneHeading>
            <p className="text-sm leading-relaxed text-ink">{workbench.userTurn}</p>
          </div>

          {/* The reply is the one turn that is typed: it is the agent's, and
           * watching it arrive is what "an agent working in here" looks like.
           * The request above is never typed, so the server render already
           * carries the task statement. */}
          {reached(1) ? (
            <div
              data-phase="reply"
              className={`border-l-2 border-action pl-4 ${live ? ARRIVE : ""}`}
            >
              <PaneHeading className="mb-1.5">{workbench.agentLabel}</PaneHeading>
              {live ? (
                <TypingAnimation
                  as="p"
                  duration={14}
                  startOnView={false}
                  className="min-h-[3lh] text-sm leading-relaxed tracking-normal text-muted"
                >
                  {workbench.agentTurn}
                </TypingAnimation>
              ) : (
                <p className="text-sm leading-relaxed text-muted">{workbench.agentTurn}</p>
              )}
            </div>
          ) : null}

          {/* Tool call: the one place cyan means "this ran". */}
          {reached(2) ? (
            <div
              data-phase="tool"
              className={`flex items-center gap-3 rounded-control border border-hairline bg-paper px-3 py-2.5 ${
                live ? ARRIVE : ""
              }`}
            >
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-action" />
              <p className="shrink-0 whitespace-nowrap font-mono text-[10px] uppercase tracking-widest text-ink">
                {workbench.toolCallLabel}
              </p>
              <p className="ml-auto truncate font-mono text-[10px] text-muted">
                {workbench.toolCallDetail}
              </p>
            </div>
          ) : null}

          <div className="mt-auto flex min-h-9 items-center gap-2 border-t border-hairline pt-4">
            {reached(4) ? (
              <>
                <span
                  aria-hidden
                  data-phase="approval"
                  className={`font-mono text-xs text-approval ${live ? ARRIVE : ""}`}
                >
                  !
                </span>
                <p
                  className={`font-mono text-[10px] uppercase tracking-widest text-approval ${
                    live ? ARRIVE : ""
                  }`}
                >
                  {workbench.statusLine}
                </p>
              </>
            ) : (
              /* Before the checkpoint the thread is still working. Three
               * stations in the stage hairline, no words: an unlabelled state
               * here would be a claim the sequence has not reached. */
              <span aria-hidden className="flex items-center gap-1">
                <span className="size-1 rounded-full bg-hairline-strong" />
                <span className="size-1 rounded-full bg-hairline-strong" />
                <span className="size-1 rounded-full bg-hairline-strong" />
              </span>
            )}
          </div>
        </div>

        {/* Workspace dock. The diff tab is the active one, so the dock shows the
         * change rather than a tab strip over an empty pane. */}
        <div className="flex flex-col">
          <ul className="flex gap-px bg-hairline">
            {[
              { key: "diff", label: workbench.tabs.diff, active: true },
              { key: "artifact", label: workbench.tabs.artifact, active: false },
            ].map((tab) => (
              <li
                key={tab.key}
                className={`flex-1 border-b-2 px-3 py-2.5 text-center font-mono text-[10px] uppercase tracking-widest ${
                  tab.active
                    ? "border-action bg-surface text-ink"
                    : "border-transparent bg-paper text-muted"
                }`}
              >
                {tab.label}
              </li>
            ))}
          </ul>

          <DiffView
            path={DEMO_TASK.diff.path}
            hunk={DEMO_TASK.diff.hunk}
            lines={reached(3) ? DEMO_TASK.diff.lines : []}
            label={copy.artifacts.diff.heading}
            limit={8}
            showHunk={false}
            reveal={live}
            className="flex-1"
          />
        </div>
      </div>
    </AppFrame>
  )
}
