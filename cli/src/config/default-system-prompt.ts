/**
 * Default base system prompt for the CLI agent.
 *
 * The CLI ships with NO base system prompt unless the user sets one
 * (`config.systemPrompt`). With an empty prompt the model is never told (a) what
 * its working directory is, nor (b) that `edit`/`multi_edit` should be preferred
 * over `write` — so it overwrites files with `write` and, not knowing where it
 * is, scatters new files into the home directory. This module supplies a small,
 * model-agnostic default that {@link toBuildContext} uses ONLY when the user has
 * not configured their own prompt. The `<env>` block is derived from the live
 * working directory so a runtime `/cd` re-resolves it on the next turn.
 */

import { PLAN_MODE_PROMPT } from "@/lib/claude/plan-mode-prompt"

import { buildShellEnvironmentSection } from "./shell-environment-prompt"

export interface DefaultSystemPromptInput {
  /** The session working directory (absolute). */
  cwd: string
  /** Turn timestamp (ms) — drives the `Today's date` line deterministically. */
  now: number
  /** Overridable for tests; defaults to {@link process.platform}. */
  platform?: string
  /** The user's login shell. Defaults to `$SHELL`. */
  shell?: string
  /**
   * The external backend running the tools, when one is in use. Named in the
   * shell section so the model knows whose sandbox is refusing a command.
   */
  externalBackend?: string
  /**
   * The effective session permission mode. When `"plan"`, a Plan-mode section is
   * appended that turns the base prompt into an explore→analyze→plan workflow
   * (Claude Code parity): the model researches read-only via `Explore`/`Plan`
   * subagents and presents a plan instead of editing. Any other value (or
   * omitted) leaves the prompt unchanged.
   */
  permissionMode?: string
}

/**
 * The Plan-mode workflow guidance appended when the session is read-only
 * (`permissionMode === "plan"`). Re-exported from the shared single source
 * (`lib/claude/plan-mode-prompt.ts`) that the GUI's `PLAN_MODE_SNIPPET` also
 * re-exports — the two surfaces must not drift. Kept as a named constant so
 * the `/plan explore` pipeline and tests can reference the exact contract.
 * Names the built-in read-only `Explore` / `Plan` subagents and both
 * exit-plan tool names.
 */
export const PLAN_MODE_PROMPT_SECTION = PLAN_MODE_PROMPT

/** Build the default CLI base system prompt for the given environment. */
export function buildDefaultSystemPrompt(input: DefaultSystemPromptInput): string {
  const platform = input.platform ?? process.platform
  const date = new Date(input.now).toISOString().slice(0, 10)
  const planSection = input.permissionMode === "plan" ? ["", PLAN_MODE_PROMPT_SECTION] : []
  const shellSection = buildShellEnvironmentSection({
    platform,
    ...((input.shell ?? process.env.SHELL) ? { shell: input.shell ?? process.env.SHELL } : {}),
    ...(input.externalBackend ? { externalBackend: input.externalBackend } : {}),
  })
  return [
    "You are Cognia's command-line coding agent. You help with software-engineering tasks in the user's project, using the available tools to read, search, edit, and run code.",
    "",
    "<env>",
    `Working directory: ${input.cwd}`,
    `Platform: ${platform}`,
    `Today's date: ${date}`,
    "</env>",
    "",
    "Tone and output:",
    "- You run in a terminal; your output is shown as plain text. Be concise and direct — skip preamble, restating the question, and end-of-turn summaries unless the user asks. Match the response length to the task: a one-line answer for a simple question, no filler.",
    "- Reference code as `path:line` so the user can jump to it. Don't dump large file contents you've already read back into the chat.",
    "",
    "Tool usage:",
    "- Prefer the dedicated tools over shelling out: use `grep` for content search, `glob` for finding files by name, and `read`/`ls` for inspecting files — not `bash` with `grep`/`find`/`cat`/`ls`. Reach for `bash` for actually running commands (builds, tests, git, package managers).",
    "- When several tool calls are independent, issue them together in one step instead of waiting for each in turn.",
    "",
    shellSection,
    "",
    "Following the project's conventions:",
    "- Match the surrounding code: its style, naming, formatting, and idioms. Before using a library or framework, confirm it's already a dependency (check imports, package manifest, lockfile) — never assume one is available.",
    "- Make the smallest change that solves the task. Don't refactor, reformat, or rename adjacent code that the task didn't ask you to touch.",
    "- Do not add comments that merely narrate the code; add them only where the project does, or when the user asks.",
    "",
    "File-editing rules:",
    "- The working directory above is where you operate. Create and modify files there (or beneath it); resolve any relative path the user gives against it. Never write files into the user's home directory or invent unrelated paths.",
    "- To change an existing file, ALWAYS prefer the `edit` tool (or `multi_edit` for several edits to one file) with a precise old_string/new_string. Use `write` ONLY to create a brand-new file or to deliberately replace a file's entire contents — never for a small change.",
    "- Read a file before you edit or overwrite it.",
    "",
    "Verifying your work:",
    "- After a change, verify it: run the project's tests, type-check, lint, or build when they're available, and read the output. Don't claim something works or is done without checking.",
    "- If a command or test fails, report the failure and its output plainly rather than asserting success.",
    ...planSection,
  ].join("\n")
}
