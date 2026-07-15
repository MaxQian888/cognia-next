/**
 * The lead's side of the blocking task review (ADR-0071): prompt + verdict
 * schema, kept pure so it unit-tests without a runtime.
 *
 * Mirrors `pr-feedback/reviewer.ts` — same two-verdict vocabulary, so the two
 * review surfaces read alike — but deliberately does NOT reuse it: that
 * reviewer tells the model to go diff a GitHub PR with its own tools, whereas
 * this lead has no tools at all and is handed the diff (see review-evidence.ts).
 */

import { z } from "zod"
import type { ReviewEvidence } from "./review-evidence"

/**
 * The lead reviews; it never edits. Saying so matters: a lead that "fixes it
 * itself" would bypass the worker's worktree entirely and land unreviewed work.
 */
export const LEAD_REVIEW_SYSTEM_PROMPT = [
  "You are the reviewing lead of an AI agent team. Judge one teammate's completed work.",
  "You cannot edit files, run commands, or use tools — you review only, and reply with JSON.",
  "Approve when the work satisfies the task and its expected output. Request changes when it is",
  "incomplete, incorrect, unsafe, or clearly deviates from the surrounding code's conventions.",
  "Prefer a few high-confidence, actionable points over nitpicks. When you request changes, the",
  "same teammate will revise the same worktree using your feedback verbatim — so address them",
  "directly and say exactly what to change.",
  "Always respond with a single ```json fenced block matching the requested shape.",
].join(" ")

export const leadReviewVerdictSchema = z.object({
  verdict: z.enum(["approved", "changes_requested"]),
  /** Actionable feedback. Required for changes_requested; a summary otherwise. */
  feedback: z.string(),
})

export type LeadReviewVerdict = z.infer<typeof leadReviewVerdictSchema>

export interface LeadReviewTask {
  id: string
  title: string
  description: string
  expectedOutput?: string
}

export interface BuildLeadReviewPromptArgs {
  task: LeadReviewTask
  workerName?: string
  workerOutput: string
  evidence: ReviewEvidence
  /** Which revision round this is: 0 = first review of the original work. */
  revision: number
  /** Feedback the lead gave on the previous round, if any. */
  previousFeedback?: string
}

/** Cap the deliverable text alongside the diff cap, for the same reason. */
const MAX_OUTPUT_CHARS = 8000

function evidenceBlock(evidence: ReviewEvidence): string {
  if (evidence.kind === "text") {
    return [
      "Changed files: none could be determined for this task.",
      "There is no diff to review — judge the written deliverable above on its own,",
      "and treat a claim of code changes with no diff to back it as grounds to request changes.",
    ].join("\n")
  }
  const scope =
    evidence.kind === "commit"
      ? "Diff of this task's branch against the run's base"
      : "Uncommitted changes in the working directory"
  return [
    `${scope} (${evidence.files.length} file(s)${evidence.truncated ? ", TRUNCATED to fit the review limit" : ""}):`,
    "```diff",
    evidence.diff ?? "",
    "```",
    evidence.truncated
      ? "Some files were omitted for size. Judge what you can see; do not assume the omitted files are wrong."
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export function buildLeadReviewPrompt(args: BuildLeadReviewPromptArgs): string {
  const { task, evidence } = args
  const output =
    args.workerOutput.length > MAX_OUTPUT_CHARS
      ? `${args.workerOutput.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]`
      : args.workerOutput

  return [
    `Review the work on task "${task.title}"${args.workerName ? ` by ${args.workerName}` : ""}.`,
    "",
    `Task: ${task.description}`,
    task.expectedOutput ? `Expected output: ${task.expectedOutput}` : "",
    "",
    args.revision > 0
      ? `This is revision ${args.revision}. You previously requested these changes:\n${args.previousFeedback ?? "(none recorded)"}\nVerify they were addressed.`
      : "",
    "",
    "The teammate reported:",
    output,
    "",
    evidenceBlock(evidence),
    "",
    "Respond with a single ```json fenced block:",
    "```json",
    '{ "verdict": "approved" | "changes_requested", "feedback": "..." }',
    "```",
  ]
    .filter((line) => line !== "")
    .join("\n")
}
