"use client"

/**
 * Document-model helpers for the plan surface (ADR-0045 UI layer).
 *
 * An `exit_plan_mode` plan carries its full markdown body in
 * `metadata.planText`; `steps[]` is the executable projection the runtime
 * re-derives from that text via `parsePlanText`. The document-first editor
 * (`components/agent/plan/plan-document.tsx`) renders the markdown as prose
 * and lets the user edit the step list *in place* inside it — the same shape
 * Cursor/Windsurf use, where the plan file is the interface.
 *
 * Everything here is pure text surgery on the source markdown so it stays
 * unit-testable without a DOM:
 *
 *  - `splitPlanDocument` finds the steps section (a heading matching
 *    `STEP_HEADING_RE` plus the contiguous list block under it) and splits the
 *    source into `before` / `steps` / `after` segments the component renders
 *    around an interactive list. Fenced code blocks are tracked so a `## Steps`
 *    inside ``` fences can never match.
 *  - `planDocHeadings` collects the heading outline (h1–h3) for the TOC chips.
 *  - `rebuildPlanText` rewrites the steps list lines in place, preserving the
 *    rest of the document byte-for-byte.
 */

export interface PlanDocHeading {
  /** 1-based source line index — the anchor the component maps onto the DOM. */
  line: number
  level: number
  text: string
}

export interface PlanDocSplit {
  /** Markdown before the steps list (includes the steps heading itself and
   *  any intro text between the heading and the list). */
  before: string
  /** The contiguous list block under the steps heading, or null when the
   *  document has no recognisable steps section. */
  steps: string[] | null
  /** Whether the steps list used ordered (`1.`) markers — rebuild keeps the
   *  original style. */
  ordered: boolean
  /** Markdown after the steps list. */
  after: string
  /** Heading outline (h1–h3, source order) for the table of contents. */
  headings: PlanDocHeading[]
}

/** Headings whose section hosts the executable step list. */
const STEP_HEADING_RE = /step|步骤|todo|task/i

const FENCE_RE = /^\s*(```|~~~)/
const HEADING_RE = /^(#{1,4})\s+(.*\S)\s*$/
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/
const ORDERED_ITEM_RE = /^\s*\d+[.)]\s+/

interface ScannedLine {
  heading?: { level: number; text: string }
  isListItem: boolean
  ordered: boolean
  inFence: boolean
}

function scanLines(text: string): ScannedLine[] {
  const out: ScannedLine[] = []
  let inFence = false
  for (const line of text.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) {
      out.push({ isListItem: false, ordered: false, inFence })
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push({ isListItem: false, ordered: false, inFence: true })
      continue
    }
    const h = line.match(HEADING_RE)
    out.push({
      heading: h ? { level: h[1].length, text: h[2] } : undefined,
      isListItem: LIST_ITEM_RE.test(line),
      ordered: ORDERED_ITEM_RE.test(line),
      inFence: false,
    })
  }
  return out
}

/**
 * Split a plan's markdown body around its steps section. When no heading
 * matches `STEP_HEADING_RE` (or the heading is not followed by a list),
 * `steps` is null and the caller renders the executable list as a trailing
 * section instead of embedding it.
 */
export function splitPlanDocument(planText: string): PlanDocSplit {
  const lines = planText.split(/\r?\n/)
  const scanned = scanLines(planText)

  const headings: PlanDocHeading[] = []
  scanned.forEach((s, i) => {
    if (s.heading && s.heading.level <= 3) {
      headings.push({ line: i, level: s.heading.level, text: s.heading.text })
    }
  })

  const split: PlanDocSplit = {
    before: planText,
    steps: null,
    ordered: true,
    after: "",
    headings,
  }

  const headingIdx = scanned.findIndex((s) => s.heading && STEP_HEADING_RE.test(s.heading.text))
  if (headingIdx < 0) return split

  // The steps list is the first contiguous run of list items (blank lines
  // tolerated between items) directly under the heading — prose between the
  // heading and the list stays in `before`.
  let listStart = -1
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const s = scanned[i]
    if (s.heading) break // next heading — the steps section ended empty
    if (s.isListItem) {
      if (listStart < 0) listStart = i
      continue
    }
    if (listStart < 0) continue // blank/prose before the first item — keep looking
    if (/^\s*$/.test(lines[i])) {
      // Blank line: keep scanning — the list may continue after it.
      continue
    }
    break // non-blank non-list line ends the block
  }
  if (listStart < 0) return split

  let listEnd = listStart
  for (let i = listStart; i < lines.length; i++) {
    if (scanned[i].isListItem) {
      listEnd = i + 1
      continue
    }
    if (/^\s*$/.test(lines[i])) continue
    break
  }

  split.steps = lines.slice(listStart, listEnd).filter((l) => LIST_ITEM_RE.test(l))
  split.ordered = ORDERED_ITEM_RE.test(lines[listStart])
  split.before = lines.slice(0, listStart).join("\n")
  split.after = lines.slice(listEnd).join("\n")
  return split
}

/** Rebuild the document with the steps list rewritten in place. When the
 *  source had no steps section the list is appended under a new heading. */
export function rebuildPlanText(
  planText: string,
  stepTitles: string[],
  stepsHeadingText = "## Steps"
): string {
  const split = splitPlanDocument(planText)
  const ordered = split.steps ? split.ordered : true
  const listLines = stepTitles.map((t, i) => (ordered ? `${i + 1}. ${t}` : `- ${t}`))
  if (split.steps === null) {
    const head = planText.replace(/\s+$/, "")
    return `${head}\n\n${stepsHeadingText}\n\n${listLines.join("\n")}\n`
  }
  const before = split.before.replace(/\s+$/, "")
  const after = split.after.replace(/^\s+/, "")
  const mid = listLines.join("\n")
  return [before, mid, after].filter(Boolean).join("\n\n") + "\n"
}

/** Title text of one list-item line, matching `parsePlanText`'s projection
 *  semantics (marker stripped, `**bold**` emphasis unwrapped). */
export function listItemTitle(line: string): string {
  const m = line.match(LIST_ITEM_RE)
  if (!m) return line.trim()
  return m[1].trim().replace(/^\*\*(.*)\*\*$/, "$1")
}

/**
 * Every list item in the document, in source order — the projection `steps[]`
 * mirrors at capture time. Two deliberate differences from `parsePlanText`:
 * fenced code blocks are skipped (a `- item` inside ``` fences is code, not a
 * step), and there is no first-line prose fallback — a document reduced to
 * zero lists projects zero steps rather than fabricating one from the title.
 */
export function projectStepTitles(planText: string): string[] {
  const lines = planText.split(/\r?\n/)
  const out: string[] = []
  scanLines(planText).forEach((s, i) => {
    if (s.isListItem) {
      const title = listItemTitle(lines[i])
      if (title) out.push(title)
    }
  })
  return out
}

/** Heading ids for TOC anchors, stable across renders for the same text. */
export function planDocHeadingId(index: number): string {
  return `pd-h-${index}`
}
