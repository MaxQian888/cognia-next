/**
 * Split instruction text into rule units with their lines (ADR-0238 §7.1).
 *
 * The audit, the conflict pass and the adherence backtest all reason about
 * "a rule": one bullet, one numbered item, one paragraph. Headings are kept as
 * the path a unit sits under (a narrower heading can scope a rule), fenced
 * code is kept whole and never treated as instruction prose, and frontmatter
 * is its own unit (a Skill's `description` is routing text, judged
 * differently from its body).
 */

export type RuleUnitKind = "bullet" | "numbered" | "paragraph" | "heading" | "code" | "frontmatter"

export interface RuleUnit {
  /** `<startLine>`; stable within one text. */
  id: string
  kind: RuleUnitKind
  /** 1-based inclusive line range. */
  startLine: number
  endLine: number
  /** The unit's text, list marker stripped, continuation lines joined with spaces. */
  text: string
  /** Heading titles above the unit, outermost first. */
  headings: string[]
}

const FENCE = /^\s*(```|~~~)/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const NUMBERED = /^(\s*)\d+[.)]\s+(.*)$/

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

export function segmentRules(text: string): RuleUnit[] {
  const lines = text.split("\n")
  const units: RuleUnit[] = []
  const headings: Array<{ level: number; title: string }> = []
  let index = 0

  const push = (kind: RuleUnitKind, start: number, end: number, body: string) => {
    const trimmed = body.replace(/\s+/g, " ").trim()
    if (!trimmed) return
    units.push({
      id: String(start + 1),
      kind,
      startLine: start + 1,
      endLine: end + 1,
      text: trimmed,
      headings: headings.map((heading) => heading.title),
    })
  }

  // Frontmatter only at the very top.
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---")
    if (close > 0) {
      push("frontmatter", 0, close, lines.slice(1, close).join("\n"))
      index = close + 1
    }
  }

  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (isBlank(line)) {
      index++
      continue
    }
    if (FENCE.test(line)) {
      const marker = FENCE.exec(line)?.[1] ?? "```"
      let end = index + 1
      while (end < lines.length && !(lines[end] ?? "").trimStart().startsWith(marker)) end++
      const last = Math.min(end, lines.length - 1)
      push("code", index, last, lines.slice(index, last + 1).join("\n"))
      index = last + 1
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      const level = heading[1]!.length
      while (headings.length > 0 && headings[headings.length - 1]!.level >= level) headings.pop()
      push("heading", index, index, heading[2] ?? "")
      headings.push({ level, title: (heading[2] ?? "").trim() })
      index++
      continue
    }
    const item = BULLET.exec(line) ?? NUMBERED.exec(line)
    if (item) {
      const kind: RuleUnitKind = BULLET.test(line) ? "bullet" : "numbered"
      const indent = item[1]!.length
      const parts = [item[2] ?? ""]
      let end = index
      // Continuation: following non-blank lines indented deeper than the marker
      // that are not themselves list items.
      while (end + 1 < lines.length) {
        const next = lines[end + 1] ?? ""
        if (isBlank(next) || BULLET.test(next) || NUMBERED.test(next) || HEADING.test(next)) break
        if (FENCE.test(next)) break
        const nextIndent = next.length - next.trimStart().length
        if (nextIndent <= indent && !/^\s/.test(next)) break
        parts.push(next.trim())
        end++
      }
      push(kind, index, end, parts.join(" "))
      index = end + 1
      continue
    }
    let end = index
    while (end + 1 < lines.length) {
      const next = lines[end + 1] ?? ""
      if (isBlank(next) || HEADING.test(next) || FENCE.test(next)) break
      if (BULLET.test(next) || NUMBERED.test(next)) break
      end++
    }
    push("paragraph", index, end, lines.slice(index, end + 1).join(" "))
    index = end + 1
  }
  return units
}

/** Units that state behavior (headings, code and frontmatter excluded). */
export function instructionUnits(units: readonly RuleUnit[]): RuleUnit[] {
  return units.filter(
    (unit) => unit.kind === "bullet" || unit.kind === "numbered" || unit.kind === "paragraph"
  )
}

/** The text with 1-based line numbers, as the model sees it. */
export function numberLines(text: string): string {
  const lines = text.split("\n")
  const width = String(lines.length).length
  return lines.map((line, i) => `${String(i + 1).padStart(width, " ")}| ${line}`).join("\n")
}
