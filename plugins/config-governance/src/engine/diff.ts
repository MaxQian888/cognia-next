/**
 * Turn findings into hunks, and selected hunks into new text (ADR-0238 §7.7).
 *
 * The prompt-audit rules for the proposed diff, enforced in code:
 * - only `remove` / `rewrite` / `add` / `move` at high or medium confidence;
 *   `flag` and low-confidence findings stay in the report;
 * - one finding per hunk, so a user takes them selectively;
 * - a hunk is computed against the original text, never the redacted copy the
 *   model saw: a rewrite over a line the redaction changed would write a
 *   placeholder into the user's file, so that finding keeps no hunk;
 * - overlapping hunks in one surface: the more confident one wins;
 * - applying re-checks every hunk's `before` lines against the current text,
 *   so a file changed since the audit is refused rather than patched blind.
 */

import type { Confidence, Finding, Hunk } from "../model"

export interface HunkSurface {
  /** The surface's original text. */
  text: string
  /** The redacted copy the model judged (same line count). */
  redacted: string
}

const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 }

function lines(text: string): string[] {
  return text.split("\n")
}

function regionUntouchedByRedaction(surface: HunkSurface, start: number, end: number): boolean {
  const original = lines(surface.text).slice(start - 1, end)
  const redacted = lines(surface.redacted).slice(start - 1, end)
  return original.every((line, index) => line === redacted[index])
}

export interface HunkBuild {
  hunks: Hunk[]
  /** Findings that warranted an edit but got no hunk, with why. */
  withheld: Array<{
    findingId: string
    reason: "redacted-region" | "overlap" | "missing-destination"
  }>
}

export function buildHunks(
  findings: readonly Finding[],
  surfaces: ReadonlyMap<string, HunkSurface>
): HunkBuild {
  const candidates: Array<{ hunk: Hunk; confidence: Confidence }> = []
  const withheld: HunkBuild["withheld"] = []
  for (const finding of findings) {
    if (finding.confidence === "low") continue
    if (!["remove", "rewrite", "add", "move"].includes(finding.action)) continue
    const { surfaceKey, startLine, endLine } = finding.location
    const surface = surfaces.get(surfaceKey)
    if (!surface || startLine === undefined || endLine === undefined) continue
    const original = lines(surface.text)
    const before = original.slice(startLine - 1, endLine)
    const proposedOnly = finding.proposedOnly === true
    const writesText =
      finding.action === "rewrite" || finding.action === "add" || finding.action === "move"
    if (writesText && !regionUntouchedByRedaction(surface, startLine, endLine)) {
      withheld.push({ findingId: finding.id, reason: "redacted-region" })
      continue
    }
    if (finding.action === "remove") {
      candidates.push({
        hunk: {
          findingId: finding.id,
          surfaceKey,
          startLine,
          endLine,
          before,
          after: [],
          proposedOnly,
        },
        confidence: finding.confidence,
      })
    } else if (finding.action === "rewrite") {
      candidates.push({
        hunk: {
          findingId: finding.id,
          surfaceKey,
          startLine,
          endLine,
          before,
          after: lines(finding.replacement ?? ""),
          proposedOnly,
        },
        confidence: finding.confidence,
      })
    } else if (finding.action === "add") {
      candidates.push({
        hunk: {
          findingId: finding.id,
          surfaceKey,
          startLine: endLine + 1,
          endLine,
          before: [],
          after: lines(finding.replacement ?? ""),
          proposedOnly,
        },
        confidence: finding.confidence,
      })
    } else {
      const destination = finding.moveTo ? surfaces.get(finding.moveTo) : undefined
      if (!destination || !finding.moveTo) {
        withheld.push({ findingId: finding.id, reason: "missing-destination" })
        continue
      }
      const destinationLines = lines(destination.text)
      // Append after the destination's last non-empty line, separated by a blank line.
      let last = destinationLines.length
      while (last > 0 && destinationLines[last - 1]!.trim() === "") last--
      candidates.push({
        hunk: {
          findingId: finding.id,
          surfaceKey,
          startLine,
          endLine,
          before,
          after: [],
          proposedOnly,
        },
        confidence: finding.confidence,
      })
      candidates.push({
        hunk: {
          findingId: finding.id,
          surfaceKey: finding.moveTo,
          startLine: last + 1,
          endLine: last,
          before: [],
          after: last > 0 ? ["", ...before] : before,
          proposedOnly,
        },
        confidence: finding.confidence,
      })
    }
  }

  // Overlaps within one surface: the more confident hunk keeps the region.
  candidates.sort((a, b) => RANK[a.confidence] - RANK[b.confidence])
  const kept: Hunk[] = []
  const dropped = new Set<string>()
  for (const { hunk } of candidates) {
    if (dropped.has(hunk.findingId)) continue
    const clash = kept.some(
      (other) =>
        other.surfaceKey === hunk.surfaceKey &&
        other.findingId !== hunk.findingId &&
        hunk.startLine <= Math.max(other.endLine, other.startLine) &&
        other.startLine <= Math.max(hunk.endLine, hunk.startLine)
    )
    if (clash) {
      dropped.add(hunk.findingId)
      withheld.push({ findingId: hunk.findingId, reason: "overlap" })
      continue
    }
    kept.push(hunk)
  }
  // A move whose second half was dropped must not apply its first half alone.
  const hunks = kept.filter((hunk) => !dropped.has(hunk.findingId))
  hunks.sort((a, b) => a.surfaceKey.localeCompare(b.surfaceKey) || a.startLine - b.startLine)
  return { hunks, withheld }
}

export class StaleHunkError extends Error {
  readonly code = "stale_hunk"
  constructor(readonly findingId: string) {
    super(`the text under ${findingId} changed since the audit`)
    this.name = "StaleHunkError"
  }
}

/** Apply hunks of one surface to its current text, bottom-up. */
export function applyHunks(text: string, hunks: readonly Hunk[]): string {
  const out = lines(text)
  const ordered = [...hunks].sort((a, b) => b.startLine - a.startLine)
  for (const hunk of ordered) {
    const current = out.slice(hunk.startLine - 1, hunk.endLine)
    if (
      current.length !== hunk.before.length ||
      current.some((line, i) => line !== hunk.before[i])
    ) {
      throw new StaleHunkError(hunk.findingId)
    }
    out.splice(hunk.startLine - 1, hunk.before.length, ...hunk.after)
  }
  return out.join("\n")
}

export interface DiffLine {
  kind: "context" | "removed" | "added"
  /** Line number in the original (removed/context) or the new text (added). */
  line: number
  text: string
}

/**
 * A hunk as display lines, with up to `context` lines around it when the
 * surface's current text is at hand (the stored run keeps only the hunk).
 */
export function renderHunk(hunk: Hunk, text?: string, context = 2): DiffLine[] {
  const original = text === undefined ? [] : lines(text)
  const span = text === undefined ? 0 : context
  const out: DiffLine[] = []
  const from = Math.max(1, hunk.startLine - span)
  for (let line = from; line < hunk.startLine; line++) {
    out.push({ kind: "context", line, text: original[line - 1] ?? "" })
  }
  hunk.before.forEach((value, index) =>
    out.push({ kind: "removed", line: hunk.startLine + index, text: value })
  )
  hunk.after.forEach((value, index) =>
    out.push({ kind: "added", line: hunk.startLine + index, text: value })
  )
  const resume = hunk.startLine + hunk.before.length
  for (let line = resume; line < Math.min(original.length + 1, resume + span); line++) {
    out.push({ kind: "context", line, text: original[line - 1] ?? "" })
  }
  return out
}
