/**
 * The review agent of an agent changeset (ADR-0227 §3): the existing per-file
 * AI diff review (`lib/git/ai-review.ts`), run over every reviewable file of
 * the pinned base → head diff, folded into one verdict.
 *
 * It is the second line, not the first. Deterministic risk and the required
 * acceptance checks gate the change whatever this says; what this adds is a
 * reader for the problems no rule names. So it must never be the reason a
 * change passes when it did not look:
 *
 * - No model → `unavailable`, which owes a human approval.
 * - A reply that is not a JSON array → `unavailable`. `generateDiffReview`
 *   degrades a malformed reply to "no findings", which is right for a UI hint
 *   and wrong for a gate, so the raw reply is inspected here.
 * - A text file left out for size or budget → `unavailable` ("incomplete"):
 *   a review of part of a change is not a review of the change.
 * - A call that throws → `unavailable`.
 *
 * Every patch passes `gateTextForModel` before it leaves: a hit is redacted
 * (on the normalized text) and re-checked, and a patch or path that still
 * leaks withholds its file, which makes the review incomplete. The outcome
 * records any redaction. Sensitive files are never read at all.
 */

import { generateDiffReview } from "@/lib/git/ai-review"
import { isSensitiveResourcePath } from "@/lib/task-workspace/run-changes"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { GitDiff, HunkFindingSeverity } from "@/types/git"

import type { ChangeRiskFile } from "./assess-change-risk"
import { gateTextForModel } from "./pii-gate"

export const REVIEW_AGENT_LIMITS = {
  /** Files reviewed at most; the rest make the review incomplete. */
  maxFiles: 40,
  /** UTF-8 bytes of one file's hunks; a bigger file makes the review incomplete. */
  maxFileBytes: 48 * 1024,
  /** UTF-8 bytes over the whole review. */
  maxTotalBytes: 256 * 1024,
} as const

export interface ReviewAgentTarget {
  repoPath: string
  baseSha: string
  headSha: string
  files: readonly ChangeRiskFile[]
}

export interface ReviewAgentDeps {
  /** Diff of one file between two commits (`gitDiffRefsFile` in production). */
  loadDiff: (repoPath: string, base: string, head: string, path: string) => Promise<GitDiff>
  /** `null` when no model is configured. */
  client: Pick<LlmClient, "complete"> | null
  customInstructions?: string
}

export type ReviewAgentSkipReason =
  | "binary"
  | "withheld"
  | "deleted"
  | "tooLarge"
  | "budget"
  /** The patch (or its path) still leaked PII after redaction, so it was not sent. */
  | "pii"
export type ReviewAgentUnavailableReason = "noModel" | "unparseable" | "failed" | "incomplete"

export interface ReviewAgentFinding {
  path: string
  severity: HunkFindingSeverity
  note: string
}

export interface ReviewAgentOutcome {
  verdict: "approve" | "requestChanges" | "unavailable"
  /** The head this review read. A verdict is meaningless for any other. */
  headSha: string
  findings: ReviewAgentFinding[]
  reviewedFiles: string[]
  skippedFiles: Array<{ path: string; reason: ReviewAgentSkipReason }>
  /** At least one patch was redacted before it was sent. */
  redacted: boolean
  unavailableReason?: ReviewAgentUnavailableReason
}

const utf8 = new TextEncoder()

/** True when the text holds something that can be a JSON array of findings. */
function looksLikeFindingsArray(text: string): boolean {
  const start = text.indexOf("[")
  return start >= 0 && text.indexOf("]", start) > start
}

export async function reviewChangesetWithAgent(
  target: ReviewAgentTarget,
  deps: ReviewAgentDeps
): Promise<ReviewAgentOutcome> {
  const outcome: ReviewAgentOutcome = {
    verdict: "approve",
    headSha: target.headSha,
    findings: [],
    reviewedFiles: [],
    skippedFiles: [],
    redacted: false,
  }
  const unavailable = (reason: ReviewAgentUnavailableReason): ReviewAgentOutcome => ({
    ...outcome,
    verdict: "unavailable",
    unavailableReason: reason,
  })

  const candidates: ChangeRiskFile[] = []
  for (const file of target.files) {
    // The host flags sensitive paths; the path check repeats it here so an
    // older or buggy host that drops the flag still never has them read.
    if (
      file.excluded ||
      file.sensitive ||
      isSensitiveResourcePath(file.path) ||
      (file.oldPath ? isSensitiveResourcePath(file.oldPath) : false)
    )
      outcome.skippedFiles.push({ path: file.path, reason: "withheld" })
    else if (file.binary) outcome.skippedFiles.push({ path: file.path, reason: "binary" })
    // A deletion has nothing new to read; its risk is the assessor's to rate.
    else if (file.status === "deleted")
      outcome.skippedFiles.push({ path: file.path, reason: "deleted" })
    else candidates.push(file)
  }
  if (candidates.length === 0) return outcome
  if (!deps.client) return unavailable("noModel")

  const client = deps.client
  let incomplete = false
  let spent = 0
  for (const [index, file] of candidates.entries()) {
    if (index >= REVIEW_AGENT_LIMITS.maxFiles) {
      outcome.skippedFiles.push({ path: file.path, reason: "budget" })
      incomplete = true
      continue
    }
    let diff: GitDiff
    try {
      diff = await deps.loadDiff(target.repoPath, target.baseSha, target.headSha, file.path)
    } catch {
      return unavailable("failed")
    }
    if (diff.isBinary) {
      outcome.skippedFiles.push({ path: file.path, reason: "binary" })
      continue
    }
    if (diff.hunks.length === 0) continue

    const combined = diff.hunks.map((hunk) => hunk.patch).join("\n")
    const bytes = utf8.encode(combined).byteLength
    if (bytes > REVIEW_AGENT_LIMITS.maxFileBytes) {
      outcome.skippedFiles.push({ path: file.path, reason: "tooLarge" })
      incomplete = true
      continue
    }
    if (spent + bytes > REVIEW_AGENT_LIMITS.maxTotalBytes) {
      outcome.skippedFiles.push({ path: file.path, reason: "budget" })
      incomplete = true
      continue
    }
    spent += bytes

    // The path is sent too (the prompt names the file), so it is gated with
    // the hunks; a path that needs redaction, or one hunk that still leaks
    // after it, withholds the whole file.
    const gatedPath = gateTextForModel(file.path)
    const gatedHunks = diff.hunks.map((hunk) => gateTextForModel(hunk.patch))
    if (!gatedPath.ok || gatedPath.redacted || gatedHunks.some((gated) => !gated.ok)) {
      outcome.skippedFiles.push({ path: file.path, reason: "pii" })
      incomplete = true
      continue
    }
    if (gatedHunks.some((gated) => gated.ok && gated.redacted)) outcome.redacted = true
    const hunks = gatedHunks.map((gated) => ({ patch: gated.ok ? gated.text : "" }))

    let raw = ""
    const observed: Pick<LlmClient, "complete"> = {
      complete: async (prompt, options) => {
        raw = await client.complete(prompt, options)
        return raw
      },
    }
    let findings: Awaited<ReturnType<typeof generateDiffReview>>
    try {
      findings = await generateDiffReview(
        {
          file: { path: file.path, status: file.status },
          hunks,
          config: deps.customInstructions ? { customInstructions: deps.customInstructions } : {},
        },
        observed
      )
    } catch {
      return unavailable("failed")
    }
    if (findings.length === 0 && !looksLikeFindingsArray(raw)) return unavailable("unparseable")

    outcome.reviewedFiles.push(file.path)
    for (const finding of findings) {
      outcome.findings.push({ path: file.path, severity: finding.severity, note: finding.note })
    }
  }

  if (outcome.findings.some((finding) => finding.severity === "critical")) {
    return { ...outcome, verdict: "requestChanges" }
  }
  if (incomplete) return unavailable("incomplete")
  return outcome
}
