/**
 * Builds the system + first-user prompt pair handed to the Claude Agent SDK
 * when the Issue → PR driver wants the agent to address one GitHub issue
 * inside a freshly-cloned worktree.
 *
 * Kept in its own module so the prompt copy can be unit-tested without
 * spinning up a sidecar session.
 */

export interface IssuePromptInputs {
  repoFullName: string
  issueNumber: number
  issueTitle: string
  issueBody: string
}

const FINALIZE_RULES = `
When you are done, finalize with a single concluding assistant message that:
  1. Begins with a one-paragraph summary of WHAT you changed and WHY.
  2. Wraps that summary inside <SUMMARY>…</SUMMARY> tags so the host can
     extract it verbatim.
  3. Lists the files you touched (path on its own line, no quotes).
  4. Does NOT include code fences for whole files; reference diffs by path.
  5. Does NOT push or open the PR — the host process does that after you
     return. Just leave the working tree clean and committable.
`.trim()

const TOOLING_RULES = `
You have full filesystem access scoped to the cloned workspace. Use the
git_* tools to inspect history, the file tools to read/write source, and
the shell tools to run linters / formatters / package tests. Prefer the
project's own scripts (e.g., \`npm test\`, \`pnpm test\`) over ad-hoc bash
commands. Never \`git push\`, never \`gh\` — leave the remote untouched.
`.trim()

const SAFETY_RULES = `
Constraints:
  • Stay inside the workspace directory. Do NOT read or write outside it.
  • Do NOT install new dependencies unless the issue explicitly requires it.
  • Do NOT alter unrelated files. Surgical edits only.
  • If the issue is ambiguous or under-specified, make the smallest
    reasonable change and explain your interpretation in the summary.
  • If you cannot make progress, finalize with an honest failure summary
    inside <SUMMARY>…</SUMMARY> — do not write speculative code.
`.trim()

export function buildIssueSystemPrompt(): string {
  return [
    "You are a careful software engineer working on a GitHub issue.",
    TOOLING_RULES,
    SAFETY_RULES,
    FINALIZE_RULES,
  ].join("\n\n")
}

export function buildIssueUserPrompt(input: IssuePromptInputs): string {
  const body =
    input.issueBody.trim() || "(no body — read the title and the codebase to infer intent)"
  return [
    `Repo: ${input.repoFullName}`,
    `Issue: #${input.issueNumber} — ${input.issueTitle}`,
    "",
    "Issue body:",
    body,
    "",
    "Address the issue end-to-end. Commit your changes locally on the current branch — the host will push and open the PR.",
  ].join("\n")
}

/**
 * Extract the contents of the LAST `<SUMMARY>…</SUMMARY>` block in a
 * string. Returns the trimmed inner text, or the original string when no
 * tag is present (so the host still has something to use as the PR body).
 */
export function extractSummary(text: string): string {
  const matches = text.matchAll(/<SUMMARY>([\s\S]*?)<\/SUMMARY>/gi)
  let last: string | undefined
  for (const m of matches) {
    last = m[1]
  }
  if (last !== undefined) return last.trim()
  return text.trim()
}
