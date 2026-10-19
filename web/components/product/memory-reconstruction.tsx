import { Glyph } from "@web/components/glyph"
import { AppFrame, PaneHeading } from "@web/components/product/app-frame"
import { DEMO_TASK } from "@web/content/demo-task"
import type { ReconstructionCopy } from "@web/content/types"

interface MemoryReconstructionProps {
  copy: ReconstructionCopy
  className?: string
}

/**
 * Where each remembered fact came from, in the order of the localised entries:
 * the test that failed, the project's instructions file, and the artifact the
 * task produced. Paths are the fixture's, so they never drift from the task.
 */
export const MEMORY_SOURCES: readonly string[] = [
  DEMO_TASK.files[1].path,
  DEMO_TASK.files[2].path,
  DEMO_TASK.artifact.file,
]

/**
 * Long-term memory after the signature task, rebuilt for /product#knowledge.
 *
 * Every entry names the file it came from, and the one the workspace has not
 * been allowed to keep yet says so: memory is reviewed before it is kept, and
 * a pending entry is a real wait on a person, so it alone carries amber.
 */
export function MemoryReconstruction({ copy, className }: MemoryReconstructionProps) {
  const { memory } = copy
  const lastIndex = memory.entries.length - 1
  return (
    <AppFrame
      title={DEMO_TASK.repository}
      meta={memory.panelLabel}
      label={copy.label}
      className={className}
    >
      <div className="border-b border-hairline bg-paper px-5 py-3">
        <p className="flex items-center gap-2.5 rounded-control border border-hairline bg-surface px-3 py-2 text-sm text-ink">
          <span aria-hidden className="shrink-0 text-muted">
            <Glyph name="memory" size={16} />
          </span>
          {memory.searchQuery}
        </p>
      </div>
      <ul className="flex flex-col bg-surface">
        {memory.entries.map((entry, position) => {
          const pending = position === lastIndex
          return (
            <li
              key={entry.text}
              data-memory-pending={pending || undefined}
              className="flex flex-col gap-2 border-t border-hairline px-5 py-4 first:border-t-0"
            >
              <p className="text-sm leading-relaxed text-ink">{entry.text}</p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <div className="flex items-center gap-2">
                  <PaneHeading>{memory.sourceLabel}</PaneHeading>
                  <span className="font-mono text-xs text-ink">{MEMORY_SOURCES[position]}</span>
                </div>
                <p className="ml-auto flex items-center gap-2 font-mono text-xs text-muted">
                  <span
                    aria-hidden
                    className={`size-1.5 rounded-full ${pending ? "bg-approval" : "bg-success"}`}
                  />
                  {entry.state}
                </p>
              </div>
            </li>
          )
        })}
      </ul>
      <p className="border-t border-hairline bg-paper px-5 py-3 text-sm text-muted">
        {memory.pendingLabel}
      </p>
    </AppFrame>
  )
}
