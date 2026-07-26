import { AppFrame, PaneHeading } from "@web/components/product/app-frame"
import { DEMO_TASK } from "@web/content/demo-task"
import type { ReconstructionCopy } from "@web/content/types"

interface DesktopReconstructionProps {
  copy: ReconstructionCopy
  className?: string
}

/**
 * The desktop shell's macro crop (spec §4.4): the command palette open over the
 * integrated terminal, with a notification reporting the state the task is
 * waiting in.
 *
 * A close crop, not a shrunken desktop and no device mock-up — the section
 * argues for the workspace being near the work, and a floating laptop bezel
 * argues for nothing. The terminal is on graphite because it is an execution
 * surface (spec §2.1).
 */
export function DesktopReconstruction({ copy, className }: DesktopReconstructionProps) {
  const { desktop } = copy

  return (
    <AppFrame
      title={DEMO_TASK.repository}
      meta={DEMO_TASK.branch}
      label={copy.label}
      className={className}
    >
      <div className="flex flex-col gap-5 p-5 md:p-6">
        {/* Command palette. Rendered as text, not an input: an input a reader
         * can focus but not use is worse than a depiction of one. */}
        <div className="rounded-panel border border-hairline-strong bg-paper">
          <div className="flex items-center gap-3 border-b border-hairline px-4 py-3">
            <PaneHeading>{desktop.paletteLabel}</PaneHeading>
            <p className="ml-auto truncate font-mono text-xs text-ink">{desktop.paletteQuery}</p>
          </div>
          <ul>
            {desktop.paletteItems.map((item, index) => (
              <li
                key={item}
                className={`flex items-center gap-3 border-l-2 px-4 py-2.5 text-sm ${
                  index === 0
                    ? "border-action bg-surface text-ink"
                    : "border-transparent text-muted"
                }`}
              >
                {item}
              </li>
            ))}
          </ul>
        </div>

        {/* Integrated terminal, on the execution substrate. */}
        <div className="overflow-hidden rounded-panel border border-on-stage-hairline bg-graphite">
          <div className="border-b border-on-stage-hairline px-4 py-2.5">
            <PaneHeading tone="stage">{desktop.terminalLabel}</PaneHeading>
          </div>
          <div className="px-4 py-3">
            <p className="flex gap-2 font-mono text-[11px] leading-5 text-on-stage md:text-xs">
              <span aria-hidden className="text-action">
                $
              </span>
              <span className="break-all">{DEMO_TASK.test.command}</span>
            </p>
            <p className="mt-1 font-mono text-[11px] leading-5 text-on-stage-muted md:text-xs">
              {DEMO_TASK.check}
            </p>
          </div>
        </div>

        {/* Notification: what a long task does when it needs the human back. */}
        <div className="flex gap-3 rounded-panel border border-hairline bg-surface p-4">
          <span aria-hidden className="mt-1 size-1.5 shrink-0 rounded-full bg-approval" />
          <div className="min-w-0">
            <PaneHeading className="mb-1.5">{desktop.notificationLabel}</PaneHeading>
            <p className="text-sm font-medium text-ink">{desktop.notificationTitle}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">{desktop.notificationBody}</p>
          </div>
        </div>
      </div>
    </AppFrame>
  )
}
