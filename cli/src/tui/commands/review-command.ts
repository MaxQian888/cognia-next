/**
 * `/review [base]` — ask the active agent for a structured code review of the
 * working tree (or the diff vs a base branch when one is given).
 *
 * Pure `send` command: no controller, no git shell-out here. The framed prompt
 * tells the agent to gather the diff via its own `git_diff`/`git_status`/`git_log`
 * builtin tools and to reach for `codegraph_impact` on touched symbols — so the
 * review streams into the transcript and the agent can iterate. Read-only.
 *
 * CLI is English-only.
 */
import type { CommandDescriptor } from "./types"

/**
 * Build the framed review instruction. Pure, so its shape is unit-tested. When
 * `base` is provided the agent diffs against that ref; otherwise it reviews the
 * staged + unstaged working tree.
 */
export function buildReviewPrompt(base: string): string {
  const scope = base
    ? `the changes on this branch versus \`${base}\` (use \`git diff ${base}...HEAD\`)`
    : "the current working-tree changes (staged + unstaged)"
  return [
    `Perform a thorough code review of ${scope}.`,
    "",
    "Steps:",
    `1. Gather the diff yourself with the git tools (git_status, git_diff${base ? `, git_log ${base}..HEAD` : ""}). Do not ask me to paste it.`,
    "2. For non-trivial changes, call codegraph_impact on the touched symbols to understand the blast radius before judging them.",
    "",
    "Report findings grouped under these headings, most severe first, and omit a heading if it has nothing:",
    "- Correctness — bugs, broken edge cases, race conditions, wrong logic.",
    "- Security — injection, unsafe input handling, leaked secrets, missing authz.",
    "- Tests — missing/weak coverage for the changed behavior.",
    "- Style & Maintainability — naming, duplication, dead code, unclear structure.",
    "",
    "For each finding cite `file:line`, give a one-line explanation, and mark a severity (blocker / major / minor / nit). End with a short overall verdict (ship / needs work) and, if nothing is wrong, say so plainly.",
  ].join("\n")
}

export const reviewCommand: CommandDescriptor = {
  name: "review",
  description: "get a structured code review of the working tree (or vs a base branch)",
  category: "cognia",
  argumentHint: "[base branch]",
  handler: (ctx) => ({ kind: "send", prompt: buildReviewPrompt(ctx.args.trim()) }),
}
