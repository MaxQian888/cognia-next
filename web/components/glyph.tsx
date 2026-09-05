import type { CSSProperties } from "react"
import { cn } from "@web/lib/utils"

/**
 * The site's bespoke marks, one per subsystem (ADR-0092 6, amended 2026-09-05).
 *
 * `Icon` is the vocabulary for controls and states, and it is Lucide's. These
 * are the product's own: each names one part of the workspace and appears
 * wherever that part is discussed, so a reader who saw the workflows mark on
 * the homepage recognises it on the workflows page. They are drawn to the same
 * discipline as the rest of the instrument: a 24 unit grid, a 1 unit stroke,
 * no fills, and geometry that survives a monochrome print.
 *
 * Every shape carries `pathLength={1}`, which lets one CSS rule (`.glyph-draw`)
 * draw any of them on entry without knowing its real length. The mark is
 * always decorative: the label it sits beside is the accessible name.
 */
const GLYPHS = {
  /** Two speech blocks, the second indented under the first. */
  chat: (
    <>
      <path pathLength={1} d="M3.5 4.5h12v8h-8l-4 3.5z" />
      <path pathLength={1} d="M17.5 9.5h3v7h-3l-3 2.5v-2.5h-5" />
    </>
  ),
  /** A plan: three ruled steps, the first ticked. */
  agents: (
    <>
      <path pathLength={1} d="M4 6.5l1.5 1.5 3-3" />
      <path pathLength={1} d="M11 6.5h9M11 12h9M11 17.5h9" />
      <path pathLength={1} d="M4.5 12h3M4.5 17.5h3" />
    </>
  ),
  /** Three agents on one thread. */
  squads: (
    <>
      <circle pathLength={1} cx="6" cy="7" r="2.5" />
      <circle pathLength={1} cx="18" cy="7" r="2.5" />
      <circle pathLength={1} cx="12" cy="18" r="2.5" />
      <path pathLength={1} d="M8 8.5l2.5 7M16 8.5l-2.5 7M8.5 7h7" />
    </>
  ),
  /** Nodes on a graph, one edge branching. */
  workflows: (
    <>
      <rect pathLength={1} x="3" y="9.5" width="5" height="5" />
      <rect pathLength={1} x="16" y="3.5" width="5" height="5" />
      <rect pathLength={1} x="16" y="15.5" width="5" height="5" />
      <path pathLength={1} d="M8 12h4V6h4M12 12v6h4" />
    </>
  ),
  /** A clock face with the hand on the next mark. */
  scheduler: (
    <>
      <circle pathLength={1} cx="12" cy="12" r="8.5" />
      <path pathLength={1} d="M12 7v5l3.5 2" />
      <path pathLength={1} d="M12 3.5v1.5M20.5 12H19M12 20.5V19M3.5 12H5" />
    </>
  ),
  /** An open book with a marked line. */
  knowledge: (
    <>
      <path pathLength={1} d="M3.5 5.5h6.5a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H3.5z" />
      <path pathLength={1} d="M20.5 5.5H14a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h6.5z" />
      <path pathLength={1} d="M6 10h4M14 10h4" />
    </>
  ),
  /** Layered records, the top one recalled forward. */
  memory: (
    <>
      <path pathLength={1} d="M4.5 16.5h15v3h-15zM4.5 11.5h15v3h-15z" />
      <path pathLength={1} d="M7.5 4.5h9v5h-9z" />
      <path pathLength={1} d="M12 9.5v2" />
    </>
  ),
  /** A framed canvas with a drawn stroke and a version tab. */
  canvas: (
    <>
      <rect pathLength={1} x="3.5" y="5.5" width="17" height="13" />
      <path pathLength={1} d="M7 15l3-5 3 3 2-2 2 4" />
      <path pathLength={1} d="M14.5 3.5h6v2h-6z" />
    </>
  ),
  /** A socket with a declared set of pins. */
  plugins: (
    <>
      <path pathLength={1} d="M6.5 9.5h11v6a5.5 5.5 0 0 1-11 0z" />
      <path pathLength={1} d="M9.5 9.5v-5M14.5 9.5v-5M12 21v-2.5" />
    </>
  ),
  /** A server exposing tools over a protocol line. */
  mcp: (
    <>
      <rect pathLength={1} x="3.5" y="4.5" width="8" height="15" />
      <path pathLength={1} d="M6 8h3M6 11h3" />
      <path pathLength={1} d="M11.5 12h4l1.5-2.5 1.5 5 1.5-2.5h.5" />
    </>
  ),
  /** Messages in and a reply out, through one gate. */
  connectors: (
    <>
      <path pathLength={1} d="M3.5 7.5h7v5h-4l-3 2.5z" />
      <path pathLength={1} d="M20.5 11.5h-7v5h4l3 2.5z" />
      <path pathLength={1} d="M12 4v3M12 17v3" />
    </>
  ),
  /** A browser tab with a page captured into the workspace. */
  browser: (
    <>
      <rect pathLength={1} x="3.5" y="4.5" width="17" height="15" />
      <path pathLength={1} d="M3.5 8.5h17M6 6.5h1M8.5 6.5h1" />
      <path pathLength={1} d="M9 14l3 3 4-5" />
    </>
  ),
  /** A pointer over a screen, the click ringed. */
  computerUse: (
    <>
      <rect pathLength={1} x="3.5" y="4.5" width="17" height="11" />
      <path pathLength={1} d="M9 20.5h6M12 15.5v5" />
      <path pathLength={1} d="M11 8l5 2-2 1 1.5 2.5-1 .5-1.5-2.5-1.5 1.5z" />
    </>
  ),
  /** A scanned page, text lines resolving under a scan rule. */
  ocr: (
    <>
      <path pathLength={1} d="M3.5 7.5v-4h4M16.5 3.5h4v4M20.5 16.5v4h-4M7.5 20.5h-4v-4" />
      <path pathLength={1} d="M7.5 9.5h9M7.5 12h9M7.5 14.5h5" />
    </>
  ),
  /** A key held at a gate. */
  permissions: (
    <>
      <circle pathLength={1} cx="8" cy="12" r="4" />
      <path pathLength={1} d="M12 12h8.5M17 12v3M19.5 12v2" />
    </>
  ),
  /** A receipt: the record of one action, torn at the foot. */
  receipts: (
    <>
      <path pathLength={1} d="M5.5 3.5h13v16l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5z" />
      <path pathLength={1} d="M8.5 8h7M8.5 11h7M8.5 14h4" />
    </>
  ),
  /** A branch with a stacked commit above it. */
  sourceControl: (
    <>
      <circle pathLength={1} cx="7" cy="5.5" r="2" />
      <circle pathLength={1} cx="7" cy="18.5" r="2" />
      <circle pathLength={1} cx="17" cy="9.5" r="2" />
      <path pathLength={1} d="M7 7.5v9M17 11.5c0 3-4 3-6.5 4.5" />
    </>
  ),
  /** A prompt with a cursor. */
  terminal: (
    <>
      <rect pathLength={1} x="3.5" y="4.5" width="17" height="15" />
      <path pathLength={1} d="M7 9l3.5 3L7 15M12.5 15h4.5" />
    </>
  ),
  /** The desktop shell: a window with a rail. */
  desktop: (
    <>
      <rect pathLength={1} x="3.5" y="4.5" width="17" height="12" />
      <path pathLength={1} d="M7.5 4.5v12M9 20.5h6" />
    </>
  ),
  /** A phone, the screen holding one decision. */
  mobile: (
    <>
      <rect pathLength={1} x="7.5" y="3.5" width="9" height="17" rx="1.5" />
      <path pathLength={1} d="M10 12.5l1.5 1.5 3-3M11 18h2" />
    </>
  ),
  /** A prompt sign without a window: the terminal is the whole surface. */
  cli: (
    <>
      <path pathLength={1} d="M4 6l5 6-5 6" />
      <path pathLength={1} d="M11 18h9" />
    </>
  ),
  /** A long-running task: a bar with a marker still moving. */
  tasks: (
    <>
      <path pathLength={1} d="M3.5 12h17" />
      <path pathLength={1} d="M3.5 9v6M20.5 9v6M9 10v4M15 10v4" />
      <circle pathLength={1} cx="12" cy="12" r="1.5" />
    </>
  ),
} as const

export type GlyphName = keyof typeof GLYPHS

export const GLYPH_NAMES = Object.keys(GLYPHS) as GlyphName[]

interface GlyphProps {
  name: GlyphName
  /** 16 beside a mono label, 20 beside a heading, 24 as a tile mark. */
  size?: 16 | 20 | 24
  /** Draw the stroke on entry. The reduced-motion belt collapses it to done. */
  draw?: boolean
  /** Delay before the draw begins, in milliseconds. */
  delayMs?: number
  className?: string
}

/**
 * One mark. Always `aria-hidden`, always a 1 unit stroke on a 24 unit grid.
 */
export function Glyph({ name, size = 20, draw = false, delayMs = 0, className }: GlyphProps) {
  const style = draw && delayMs ? ({ "--glyph-delay": `${delayMs}ms` } as CSSProperties) : undefined
  return (
    <svg
      aria-hidden
      focusable="false"
      data-glyph={name}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0", draw && "glyph-draw", className)}
      style={style}
    >
      {GLYPHS[name]}
    </svg>
  )
}
