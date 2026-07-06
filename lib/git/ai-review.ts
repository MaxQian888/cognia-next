/**
 * Pure prompt assembly + one-shot generation for AI per-hunk code review.
 *
 * Mirrors `lib/git/ai-commit.ts`: no React, stores, or Tauri, so it is trivially
 * unit-testable with a mock `{ complete }`. The caller (`useAiDiffReview`) owns
 * PII gating, model resolution, and writing findings into the review store.
 *
 * The model is asked to return a JSON array of findings keyed by 1-based hunk
 * number; `generateDiffReview` parses + normalizes it, degrading to `[]` on any
 * parse failure so a malformed response never throws into the UI.
 */

import { clampDiff } from "@/lib/git/ai-commit"
import { extractJson } from "@/lib/twin/distill/llm"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { GitFileChange, HunkFindingSeverity } from "@/types/git"

export interface DiffReviewConfig {
  /** Optional extra steering appended to the system prompt. */
  customInstructions?: string
}

/** One hunk fed to the model — `patch` is already PII-gated by the caller. */
export interface ReviewHunkInput {
  patch: string
}

export interface BuildReviewInput {
  /** File this diff belongs to (path + status for context). */
  file: Pick<GitFileChange, "path" | "status">
  /** Hunks in display order; numbered 1..N in the prompt. */
  hunks: ReviewHunkInput[]
  config: DiffReviewConfig
}

/** A normalized finding: which hunk (1-based), how serious, and the note. */
export interface ReviewFinding {
  hunk: number
  severity: HunkFindingSeverity
  note: string
}

const SEVERITIES: readonly HunkFindingSeverity[] = ["info", "warning", "critical"]

export function buildReviewSystemPrompt(config: DiffReviewConfig): string {
  const lines = [
    "You are a concise, senior code reviewer examining a single file's diff.",
    "The diff is split into numbered hunks. Review each hunk for real problems: bugs, logic errors, security issues, resource leaks, missing error handling, or clear style/maintainability concerns.",
    "Output ONLY a JSON array (no markdown fences, no prose) of findings:",
    '[{"hunk": <1-based number>, "severity": "info"|"warning"|"critical", "note": "<one short sentence>"}]',
    "Rules: at most one finding per hunk (the most important). Omit hunks that look fine — return [] when nothing is worth flagging. Keep each note under 200 characters, specific, and actionable. Never invent issues not visible in the diff.",
    'Use "critical" only for correctness/security bugs, "warning" for likely problems, "info" for minor suggestions.',
  ]
  const extra = config.customInstructions?.trim()
  if (extra) lines.push(`Additional instructions: ${extra}`)
  return lines.join("\n")
}

export function buildReviewUserPrompt(input: BuildReviewInput): string {
  const body = input.hunks
    .map((h, i) => [`### Hunk ${i + 1}`, "```diff", h.patch, "```"].join("\n"))
    .join("\n\n")
  return [`File: ${input.file.path} (${input.file.status})`, "", clampDiff(body)].join("\n")
}

/** Coerce an unknown model item into a valid finding, or `null` to drop it. */
function normalizeFinding(raw: unknown, hunkCount: number): ReviewFinding | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const hunk = Number(obj.hunk)
  if (!Number.isInteger(hunk) || hunk < 1 || hunk > hunkCount) return null
  const note = typeof obj.note === "string" ? obj.note.trim() : ""
  if (!note) return null
  const severity = SEVERITIES.includes(obj.severity as HunkFindingSeverity)
    ? (obj.severity as HunkFindingSeverity)
    : "info"
  return { hunk, severity, note }
}

/**
 * Recover as many complete finding objects as possible from a possibly-truncated
 * JSON array. When the model's response is cut off mid-array by the token cap,
 * `extractJson` throws on the unterminated span and the whole review would be
 * lost (rendering as a misleading "no findings"). This walks the first `[ … `
 * span, collecting each balanced top-level `{ … }` object and parsing them
 * individually, so only the incomplete trailing object is dropped.
 */
export function salvageFindingsArray(text: string): unknown[] {
  const start = text.indexOf("[")
  if (start === -1) return []
  const out: unknown[] = []
  let depth = 0
  let objStart = -1
  let inString = false
  let escape = false
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === "\\") {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") {
      if (depth === 0) objStart = i
      depth += 1
    } else if (ch === "}") {
      depth -= 1
      if (depth === 0 && objStart >= 0) {
        try {
          out.push(JSON.parse(text.slice(objStart, i + 1)))
        } catch {
          // Drop an individually-unparseable object; keep the rest.
        }
        objStart = -1
      }
    } else if (ch === "]" && depth === 0) {
      break
    }
  }
  return out
}

/**
 * Output-token budget for the review call. A file can flag one finding per hunk;
 * a flat 800-token cap silently truncated the JSON array on many-hunk files,
 * making `extractJson` throw and dropping ALL findings. Scale with hunk count
 * (each finding is one short JSON object) and cap so a pathological file can't
 * request an unbounded completion.
 */
function reviewMaxTokens(hunkCount: number): number {
  return Math.min(4096, 600 + hunkCount * 110)
}

/**
 * One-shot generation: assemble prompts, call the resolved utility LLM client,
 * parse + normalize the findings. Never throws: on an unterminated (truncated)
 * response it salvages the complete findings that did arrive rather than showing
 * a misleading "no findings"; on a total parse miss it degrades to `[]`.
 */
export async function generateDiffReview(
  input: BuildReviewInput,
  client: Pick<LlmClient, "complete">
): Promise<ReviewFinding[]> {
  if (input.hunks.length === 0) return []
  const text = await client.complete(buildReviewUserPrompt(input), {
    system: buildReviewSystemPrompt(input.config),
    temperature: 0.2,
    maxTokens: reviewMaxTokens(input.hunks.length),
  })
  let parsed: unknown
  try {
    parsed = extractJson<unknown>(text)
  } catch {
    // Likely truncated mid-array by the token cap — salvage the complete
    // findings instead of dropping the entire review.
    parsed = salvageFindingsArray(text)
  }
  if (!Array.isArray(parsed)) return []
  const seen = new Set<number>()
  const out: ReviewFinding[] = []
  for (const item of parsed) {
    const finding = normalizeFinding(item, input.hunks.length)
    // One finding per hunk — keep the first the model emitted for each.
    if (finding && !seen.has(finding.hunk)) {
      seen.add(finding.hunk)
      out.push(finding)
    }
  }
  return out
}
