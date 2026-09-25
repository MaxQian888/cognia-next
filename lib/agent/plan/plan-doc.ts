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
 *    The split also carries the heading outline (h1–h3) for the TOC chips.
 *  - `rebuildPlanText` rewrites the steps list lines in place, preserving the
 *    rest of the document byte-for-byte.
 *  - `stepsSectionWindow` locates the steps section inside the executable
 *    projection (the slice the embedded editor and a refinement own).
 *  - `planDocTitle` / `withoutRestatedTitle` / `retitlePlanText` treat the
 *    document's leading `# H1` as the plan's name: capture derives the title
 *    from it, surfaces that already print the title skip it, and a title edit
 *    rewrites it so the two never disagree.
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
 *  source had no steps section the list is appended under a new heading, and
 *  replaces the document's list items: with no section, every one of them was
 *  a step (see `stepsSectionWindow`), so keeping them would project each old
 *  step alongside the new list. */
export function rebuildPlanText(
  planText: string,
  stepTitles: string[],
  stepsHeadingText = "## Steps"
): string {
  const split = splitPlanDocument(planText)
  const ordered = split.steps ? split.ordered : true
  const listLines = stepTitles.map((t, i) => (ordered ? `${i + 1}. ${t}` : `- ${t}`))
  if (split.steps === null) {
    const scanned = scanLines(planText)
    const head = planText
      .split(/\r?\n/)
      .filter((_, i) => !scanned[i].isListItem)
      .join("\n")
      .replace(/\s+$/, "")
    return `${head ? `${head}\n\n` : ""}${stepsHeadingText}\n\n${listLines.join("\n")}\n`
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

/**
 * Where the document's steps section sits inside the executable projection.
 *
 * The projection collects every list item in document order, so the section
 * (`section`, its item titles) is one contiguous run of `titles`. No section
 * means the whole projection is the steps. When the two drifted apart (a
 * refinement or an older write touched one side) the window anchors at the top
 * with the section's row count, so a surface never shows more rows than the
 * section owns.
 */
export function stepsSectionWindow(
  section: string[] | null,
  titles: string[]
): { start: number; end: number } {
  if (!section?.length) return { start: 0, end: titles.length }
  for (let i = 0; i + section.length <= titles.length; i++) {
    if (section.every((s, k) => s === titles[i + k])) {
      return { start: i, end: i + section.length }
    }
  }
  return { start: 0, end: Math.min(section.length, titles.length) }
}

/** A "Plan:" label is chrome, not part of the name: every surface already says "plan". */
const PLAN_LABEL_RE = /^(?:plan|计划|方案)\s*[:：]\s*/i
const TITLE_HEADING_RE = /^#\s+(.*\S)\s*$/

/** Index of the document's opening line when it is a `# H1`, else -1. */
function leadingTitleLine(lines: string[]): number {
  const at = lines.findIndex((l) => l.trim().length > 0)
  return at >= 0 && TITLE_HEADING_RE.test(lines[at]) ? at : -1
}

/**
 * The document's own name: its leading `# H1` (the first non-blank line), with
 * bold emphasis unwrapped and a "Plan:" label dropped. `null` when the body
 * does not open with an H1 — a `## Context` section is not a name for a plan.
 */
export function planDocTitle(planText: string): string | null {
  const lines = planText.split(/\r?\n/)
  const at = leadingTitleLine(lines)
  if (at < 0) return null
  const text = (lines[at].match(TITLE_HEADING_RE)?.[1] ?? "")
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .replace(PLAN_LABEL_RE, "")
    .trim()
  return text || null
}

/**
 * The body to print under a surface that already shows `title`: the leading
 * H1 is dropped when it restates that title, so the name is not printed twice
 * and does not head the outline. Display only — edits keep rewriting the full
 * source.
 */
export function withoutRestatedTitle(planText: string, title: string): string {
  if (planDocTitle(planText) !== title.trim()) return planText
  const lines = planText.split(/\r?\n/)
  const rest = lines.slice(leadingTitleLine(lines) + 1).join("\n")
  return rest.replace(/^(?:[ \t]*\r?\n)+/, "")
}

/**
 * Rewrite the leading H1 to `title`, preserving the rest byte-for-byte. A body
 * with no leading H1 is returned unchanged — renaming a plan never invents a
 * heading the author did not write.
 */
export function retitlePlanText(planText: string, title: string): string {
  const lines = planText.split(/\r?\n/)
  const at = leadingTitleLine(lines)
  if (at < 0) return planText
  lines[at] = `# ${title}`
  return lines.join("\n")
}
