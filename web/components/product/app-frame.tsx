import type { ReactNode } from "react"

export type FrameTone = "surface" | "stage"

interface AppFrameProps {
  /** Left of the title bar: the project the reconstruction is showing. */
  title: string
  /** Mono meta after the title — the branch, a path, a count. */
  meta?: string
  /**
   * The honesty marker (ADR-0092 §8). Required, not optional: a rebuilt
   * interface with no marker is a mock-up presented as a photograph of the
   * product, which is the failure mode the whole visual discipline exists to
   * prevent.
   */
  label: string
  tone?: FrameTone
  children: ReactNode
  className?: string
}

/**
 * Window chrome for a DOM reconstruction of a Cognia surface.
 *
 * Depth comes from borders, hierarchy and cropping rather than a large floating
 * shadow (spec §3.3), and there is no imitation of a specific operating
 * system's window controls — the frame reads as a workspace boundary, not as a
 * screenshot of somebody's desktop.
 */
export function AppFrame({
  title,
  meta,
  label,
  tone = "surface",
  children,
  className,
}: AppFrameProps) {
  const onStage = tone === "stage"

  return (
    <div
      data-reconstruction="frame"
      className={`overflow-hidden rounded-stage border ${
        onStage ? "border-on-stage-hairline bg-stage" : "border-hairline bg-surface"
      } ${className ?? ""}`}
    >
      <div
        className={`flex items-center gap-3 border-b px-4 py-2.5 ${
          onStage ? "border-on-stage-hairline bg-graphite" : "border-hairline bg-paper"
        }`}
      >
        <p className={`truncate font-mono text-xs ${onStage ? "text-on-stage" : "text-ink"}`}>
          {title}
        </p>
        {meta ? (
          <p
            className={`hidden truncate font-mono text-xs sm:block ${
              onStage ? "text-on-stage-muted" : "text-muted"
            }`}
          >
            {meta}
          </p>
        ) : null}
        <p
          className={`ml-auto shrink-0 font-mono text-[10px] uppercase tracking-widest ${
            onStage ? "text-on-stage-muted" : "text-muted"
          }`}
        >
          {label}
        </p>
      </div>
      {children}
    </div>
  )
}

interface PaneHeadingProps {
  children: ReactNode
  tone?: FrameTone
  className?: string
}

/**
 * A pane label inside a frame. Monospaced because it names a region of a tool
 * rather than reading as prose (spec §3.2).
 */
export function PaneHeading({ children, tone = "surface", className }: PaneHeadingProps) {
  return (
    <p
      className={`font-mono text-[10px] uppercase tracking-widest ${
        tone === "stage" ? "text-on-stage-muted" : "text-muted"
      } ${className ?? ""}`}
    >
      {children}
    </p>
  )
}
