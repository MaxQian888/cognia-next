import type { DiffLine } from "@web/content/demo-task"

/** Gutter mark per line kind. Never colour alone (spec §8). */
const MARK: Record<DiffLine["kind"], string> = {
  context: " ",
  add: "+",
  remove: "−",
}

const LINE_CLASS: Record<DiffLine["kind"], string> = {
  context: "text-on-stage-muted",
  add: "bg-success/12 text-on-stage",
  remove: "bg-destructive/12 text-on-stage-muted line-through decoration-destructive/40",
}

const MARK_CLASS: Record<DiffLine["kind"], string> = {
  context: "text-on-stage-hairline",
  add: "text-success",
  remove: "text-destructive",
}

interface DiffViewProps {
  path: string
  hunk: string
  lines: DiffLine[]
  /** Screen-reader description of what the diff shows. */
  label: string
  /** Truncates to the first N lines for the compact dock rendering. */
  limit?: number
  /**
   * The hunk header competes with the path for room. In a narrow dock the path
   * is the useful half, so the caller drops the hunk rather than letting both
   * ellipsise into nothing.
   */
  showHunk?: boolean
  className?: string
}

/**
 * A unified diff on the graphite execution substrate (spec §2.1 — diffs, logs
 * and permissions live on the dark stage in both themes).
 *
 * The added / removed distinction is carried by a gutter mark and a strike, not
 * only by the tint, so it survives a monochrome print and a colour-vision
 * difference. Line numbers are deliberately absent: they would be invented, and
 * a fabricated line number in a reconstruction is exactly the kind of detail
 * that reads as evidence without being any.
 */
export function DiffView({
  path,
  hunk,
  lines,
  label,
  limit,
  showHunk = true,
  className,
}: DiffViewProps) {
  const shown = limit ? lines.slice(0, limit) : lines

  return (
    <figure className={`bg-graphite ${className ?? ""}`}>
      <figcaption className="flex items-baseline gap-3 border-b border-on-stage-hairline px-4 py-2.5">
        <span className="truncate font-mono text-xs text-on-stage">{path}</span>
        {showHunk ? (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-on-stage-muted">{hunk}</span>
        ) : null}
      </figcaption>

      <ol aria-label={label} className="py-2">
        {shown.map((line, index) => (
          <li
            key={`${line.kind}-${index}-${line.text}`}
            className={`flex gap-3 px-4 font-mono text-[11px] leading-5 md:text-xs ${LINE_CLASS[line.kind]}`}
          >
            <span aria-hidden className={`w-2 shrink-0 ${MARK_CLASS[line.kind]}`}>
              {MARK[line.kind]}
            </span>
            <span className="whitespace-pre-wrap break-words">{line.text}</span>
          </li>
        ))}
      </ol>
    </figure>
  )
}
