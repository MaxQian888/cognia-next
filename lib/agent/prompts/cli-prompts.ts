/**
 * Prompts only the CLI sends (ADR-0236): its output styles, the `/plan refine`
 * turn, the slash-command instructions (`/commit`, `/pr`, `/fix`, `/init`
 * rewrite, `/analyze`, `/review`) and the handoff preamble a resumed desktop
 * session starts with.
 *
 * Defined here rather than in the CLI so the app's Prompt Center can list and
 * edit them (the app never imports `cli/`), the same split as the CLI base
 * identity (`./cli-base`). The CLI builders compute every value (truncated
 * diffs, `(none)` fallbacks, the review scope) and resolve these bodies with
 * them; conditional wording stays in the builders because a template has no
 * conditionals.
 *
 * The command and session entries allow the workspace scope: the CLI resolves
 * in a directory, and the workspace a workspace override targets is the one
 * mounting the cwd (`cli/src/agent/prompt-overrides.ts`).
 */

import { DEFAULT_VISION_PROMPT } from "@cognia/ocr/providers/_llm-vision"
import { definePrompt, type PromptVariableSpec } from "@/lib/prompts/types"

/** Bound for values that are uncapped today (user-typed commands, git output). */
const UNCAPPED = 1_000_000

function vars(
  specs: Record<string, { required?: boolean; maxChars?: number }>
): PromptVariableSpec[] {
  return Object.entries(specs).map(([name, spec]) => ({
    name,
    required: spec.required ?? false,
    maxChars: spec.maxChars ?? UNCAPPED,
  }))
}

/** The output styles that append an instruction (`default` appends nothing). */
export type CliOutputStyleWithPrompt = "concise" | "explanatory" | "learning"

function cliOutputStylePrompt(style: CliOutputStyleWithPrompt, defaultBody: string) {
  return definePrompt({
    id: `chat.cli.output-style.${style}`,
    contractVersion: 1,
    kind: "runtime-baseline",
    group: "chat",
    operation: "replace-template",
    scopes: ["account", "workspace"],
    activation: "next-operation",
    risk: "ordinary",
    hosts: ["cli"],
    maxChars: 4_000,
    outputContract:
      "Appended to the CLI system prompt after a blank line while the style is active.",
    consumers: ["cli/src/config/output-style.ts"],
    defaultBody,
  })
}

/** The instruction each non-default `/output-style` appends to the system prompt. */
export const CLI_OUTPUT_STYLE_PROMPTS = {
  concise: cliOutputStylePrompt(
    "concise",
    [
      "Output style: Concise.",
      "Answer in as few words as correctness allows. Lead with the result, skip",
      "preamble and restating the question, and prefer short lists or single",
      "sentences over paragraphs. Only expand when the user asks for detail.",
    ].join(" ")
  ),
  explanatory: cliOutputStylePrompt(
    "explanatory",
    [
      "Output style: Explanatory.",
      "Alongside the solution, explain the reasoning and the trade-offs behind it —",
      "why this approach over the alternatives, and which assumptions it rests on —",
      "so the user understands not just what to do but why.",
    ].join(" ")
  ),
  learning: cliOutputStylePrompt(
    "learning",
    [
      "Output style: Learning.",
      "Act as a coding mentor. Break the work into steps, explain the underlying",
      "concepts as they come up, and where it helps the user learn, leave a clearly",
      "marked small piece for them to complete rather than writing every line.",
    ].join(" ")
  ),
} as const satisfies Record<CliOutputStyleWithPrompt, ReturnType<typeof definePrompt>>

/**
 * The synthetic user turn `/plan refine` sends after re-entering plan mode. The
 * reviewed plan and the requested revisions are appended below it in code.
 */
export const CLI_PLAN_REFINE_PROMPT = definePrompt({
  id: "agent.cli.plan-refine",
  contractVersion: 1,
  kind: "feature-template",
  group: "agents",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["cli"],
  maxChars: 4_000,
  outputContract:
    "Sent as the user turn of a plan-mode turn, followed by the current reviewed plan and any requested revisions.",
  consumers: ["cli/src/tui/runtime/plan.ts"],
  defaultBody:
    "Let's refine the plan. Reconsider the approach from the plan above and propose an updated plan — research only, do not make any changes yet.",
})

export const CLI_COMMIT_MESSAGE_PROMPT = definePrompt({
  id: "developer.cli.commit-message",
  contractVersion: 1,
  kind: "feature-template",
  group: "developer",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["cli"],
  maxChars: 8_000,
  // The diff is cut at 12,000 characters plus a truncation marker.
  variables: vars({ branch: {}, changedFiles: {}, diff: { required: true, maxChars: 20_000 } }),
  outputContract:
    "The trimmed reply is shown for confirmation as the commit message; the configured co-author trailer is appended in code.",
  consumers: ["cli/src/tui/runtime/commit-controller.ts"],
  defaultBody: [
    "Write a Conventional Commit message for the following staged changes.",
    "",
    "Branch: {{branch}}",
    "Changed files:",
    "{{changedFiles}}",
    "",
    "Staged diff:",
    "```diff",
    "{{diff}}",
    "```",
    "",
    "Requirements:",
    "- First line: `type(scope): subject` — type is one of feat, fix, docs, style, refactor, perf, test, build, ci, chore. Scope is optional. The description after the colon must be lowercase and imperative, and the whole first line must be 72 characters or fewer.",
    "- Then a blank line, then a body that wraps at 100 columns and explains WHAT changed and WHY (not how).",
    "- Output ONLY the commit message — no code fences, no commentary, and do NOT add a Co-Authored-By trailer (it is appended automatically).",
  ].join("\n"),
})

export const CLI_PR_SUMMARY_PROMPT = definePrompt({
  id: "developer.cli.pr-summary",
  contractVersion: 1,
  kind: "feature-template",
  group: "developer",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  // `parsePrDraft` reads the `Title:` / `Body:` lines this body asks for.
  risk: "protocol",
  hosts: ["cli"],
  maxChars: 8_000,
  variables: vars({ branch: {}, base: {}, commits: { required: true }, diffstat: {} }),
  requiredFragments: ["Title:", "Body:"],
  outputContract:
    "Parsed into a title (the `Title:` line) and a body (after `Body:`), falling back to first line / rest; the PR footer is appended in code.",
  consumers: ["cli/src/tui/runtime/pr-controller.ts"],
  defaultBody: [
    "Summarize this branch (`{{branch}}`) into a pull request against `{{base}}`.",
    "",
    "Commits:",
    "{{commits}}",
    "",
    "Diffstat:",
    "{{diffstat}}",
    "",
    "Produce exactly this format (no code fences, no extra commentary):",
    "Title: <a Conventional-Commit-style one-line title, 72 chars or fewer>",
    "Body:",
    "## Summary",
    "<1-3 sentences on the intent of the change>",
    "## Changes",
    "<bulleted list of the notable changes>",
    "## Test plan",
    "<how a reviewer can verify this>",
  ].join("\n"),
})

export const CLI_FIX_TESTS_PROMPT = definePrompt({
  id: "developer.cli.fix-tests",
  contractVersion: 1,
  kind: "feature-template",
  group: "developer",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["cli"],
  maxChars: 8_000,
  // The output keeps the last 12,000 characters plus a truncation marker.
  variables: vars({
    command: {},
    code: { maxChars: 32 },
    round: { maxChars: 32 },
    maxRounds: { maxChars: 32 },
    output: { required: true, maxChars: 20_000 },
  }),
  outputContract:
    "Sent as the user turn of each `/fix` round; the test command is re-run after the agent's edits.",
  consumers: ["cli/src/tui/runtime/fix-run.ts"],
  defaultBody: [
    "The test command `{{command}}` failed (exit {{code}}) — round {{round}}/{{maxRounds}}.",
    "",
    "Test output:",
    "```",
    "{{output}}",
    "```",
    "",
    "Fix the failing tests by editing the code (or the tests themselves only if they are genuinely wrong). Make the smallest change that addresses the actual failure — do not refactor unrelated code.",
    "Do NOT run the tests yourself: they are re-run automatically after your edits and the results fed back to you.",
  ].join("\n"),
})

export const CLI_INIT_REWRITE_PROMPT = definePrompt({
  id: "developer.cli.init-rewrite",
  contractVersion: 1,
  kind: "feature-template",
  group: "developer",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["cli"],
  maxChars: 8_000,
  variables: vars({
    projectName: {},
    current: { required: true },
    scripts: {},
    dependencies: {},
    dirs: {},
    readme: {},
  }),
  outputContract:
    "The trimmed reply is shown for confirmation and, once confirmed, written as the new AGENTS.md.",
  consumers: ["cli/src/tui/runtime/init-controller.ts"],
  defaultBody: [
    'You are editing the project instruction file AGENTS.md for "{{projectName}}".',
    "",
    "Current AGENTS.md:",
    "---",
    "{{current}}",
    "---",
    "",
    "Project context:",
    "- Scripts: {{scripts}}",
    "- Dependencies: {{dependencies}}",
    "- Top-level dirs: {{dirs}}",
    "- README excerpt:",
    "{{readme}}",
    "",
    "Rewrite AGENTS.md to be clear, complete, and useful for an AI coding assistant.",
    "Include these sections: Project overview, Tech stack, Commands, Conventions, Notes for the agent.",
    "Output ONLY the markdown content; do not wrap it in a code block or add commentary.",
  ].join("\n"),
})

export const CLI_BASH_ANALYSIS_PROMPT = definePrompt({
  id: "developer.cli.bash-analysis",
  contractVersion: 1,
  kind: "feature-template",
  group: "developer",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["cli"],
  maxChars: 4_000,
  // `exit` is empty or " (exit code N)".
  variables: vars({ exit: { maxChars: 64 }, command: { required: true }, output: {} }),
  outputContract: "Sent as the user turn `/analyze` starts for the last failed `!command`.",
  consumers: ["cli/src/tui/commands/bash-shellout.ts"],
  defaultBody: [
    "The following shell command failed{{exit}}. Diagnose the root cause and suggest a fix.",
    "",
    "Command:",
    "```sh",
    "{{command}}",
    "```",
    "",
    "Output:",
    "```",
    "{{output}}",
    "```",
  ].join("\n"),
})

export const CLI_REVIEW_PROMPT = definePrompt({
  id: "developer.cli.review",
  contractVersion: 1,
  kind: "feature-template",
  group: "developer",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["cli"],
  maxChars: 8_000,
  // `scope` names what is reviewed (working tree, or the branch versus a base);
  // `gitLogStep` is empty or ", git_log <base>..HEAD".
  variables: vars({ scope: { required: true }, gitLogStep: {} }),
  outputContract: "Sent as the user turn `/review` starts; the review streams into the transcript.",
  consumers: ["cli/src/tui/commands/review-command.ts"],
  defaultBody: [
    "Perform a thorough code review of {{scope}}.",
    "",
    "Steps:",
    "1. Gather the diff yourself with the git tools (git_status, git_diff{{gitLogStep}}). Do not ask me to paste it.",
    "2. For non-trivial changes, call codegraph_impact on the touched symbols to understand the blast radius before judging them.",
    "",
    "Report findings grouped under these headings, most severe first, and omit a heading if it has nothing:",
    "- Correctness — bugs, broken edge cases, race conditions, wrong logic.",
    "- Security — injection, unsafe input handling, leaked secrets, missing authz.",
    "- Tests — missing/weak coverage for the changed behavior.",
    "- Style & Maintainability — naming, duplication, dead code, unclear structure.",
    "",
    "For each finding cite `file:line`, give a one-line explanation, and mark a severity (blocker / major / minor / nit). End with a short overall verdict (ship / needs work) and, if nothing is wrong, say so plainly.",
  ].join("\n"),
})

/**
 * The preamble a resumed desktop session's first CLI turn carries: the earlier
 * conversation (historical `@` references already made inert) above the new
 * prompt. The inert rewrite is the guard; the sentence only explains it.
 */
export const CLI_HANDOFF_PROMPT = definePrompt({
  id: "chat.cli.handoff",
  contractVersion: 1,
  kind: "feature-template",
  group: "chat",
  operation: "replace-template",
  scopes: ["account", "workspace"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["cli"],
  maxChars: 4_000,
  variables: vars({ transcript: { required: true }, prompt: { required: true } }),
  outputContract:
    "Sent as the first user turn of the resumed session; the transcript records the new prompt alone.",
  consumers: ["cli/src/cli/handoff-cmd.ts"],
  defaultBody:
    "Continuing a prior session. Earlier conversation (historical @ references are displayed as ＠ and must not be read automatically):\n\n{{transcript}}\n\n---\n\n{{prompt}}",
})

/**
 * The page-transcription instruction the CLI's OCR fallback sends with an
 * image or PDF page (Claude vision). CLI-only: in the app this text is owned by
 * the OCR settings' per-provider "prompt template", so registering the app path
 * here would give the slot two authorities. Account scope only: the attachment
 * builder that runs OCR carries no workspace.
 */
export const CLI_OCR_VISION_PROMPT = definePrompt({
  id: "knowledge.ocr.vision",
  contractVersion: 1,
  kind: "feature-template",
  group: "knowledge",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  risk: "ordinary",
  hosts: ["cli"],
  maxChars: 4_000,
  outputContract:
    "Sent (trimmed) with the page image; the reply becomes the attachment's extracted Markdown text, and an empty reply counts as an OCR failure.",
  consumers: ["cli/src/agent/attachments/ocr.ts"],
  defaultBody: DEFAULT_VISION_PROMPT,
})
