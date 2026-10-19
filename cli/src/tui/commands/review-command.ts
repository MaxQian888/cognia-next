/**
 * `/review [base]` — ask the active agent for a structured code review of the
 * working tree (or the diff vs a base branch when one is given).
 *
 * Pure command: no controller, no git shell-out here. The handler names the base
 * and the App builds the framed prompt (`review` effect). The framed prompt
 * tells the agent to gather the diff via its own `git_diff`/`git_status`/`git_log`
 * builtin tools and to reach for `codegraph_impact` on touched symbols — so the
 * review streams into the transcript and the agent can iterate. Read-only.
 *
 * CLI is English-only.
 */
import { CLI_REVIEW_PROMPT } from "@/lib/agent/prompts/cli-prompts"
import { resolvePrompt } from "@/lib/prompts/resolve"
import type { PromptResolutionContext } from "@/lib/prompts/types"
import type { CommandDescriptor } from "./types"

/**
 * Build the framed review instruction from the `developer.cli.review` slot
 * (ADR-0236). Pure apart from reading the loaded override snapshot. When
 * `base` is provided the agent diffs against that ref; otherwise it reviews
 * the staged + unstaged working tree.
 */
export function buildReviewPrompt(base: string, context: PromptResolutionContext = {}): string {
  const scope = base
    ? `the changes on this branch versus \`${base}\` (use \`git diff ${base}...HEAD\`)`
    : "the current working-tree changes (staged + unstaged)"
  return resolvePrompt(CLI_REVIEW_PROMPT, {
    context,
    values: { scope, gitLogStep: base ? `, git_log ${base}..HEAD` : "" },
  }).text
}

export const reviewCommand: CommandDescriptor = {
  name: "review",
  description: "get a structured code review of the working tree (or vs a base branch)",
  category: "cognia",
  argumentHint: "[base branch]",
  handler: (ctx) => ({ kind: "review", base: ctx.args.trim() }),
}
