/**
 * `/commit` controller — generate a Conventional Commit message from the staged
 * diff, confirm it, then create the commit.
 *
 * Clones the `/init` staged-draft pattern: generate text with a locked-down
 * headless turn, stash the draft in `TuiState`, open a `confirm` overlay whose
 * `onConfirmCommand` re-dispatches the apply verb. Git is driven by a direct argv
 * child process (not the agent's git tool) so the confirm-gate holds the exact
 * bytes and the sequence is deterministic; a plain `git commit` runs the repo's
 * husky hooks (pre-commit → lint-staged, commit-msg → commitlint) natively.
 *
 * Git safety (hard rules): never commit to `master`/`main` (the repo branches off
 * `master`), never `--no-verify`. On a hook/commitlint failure the commit was
 * never created — we surface stderr and stop; the user fixes and re-runs.
 *
 * CLI is English-only.
 */
import {
  DEFAULT_COAUTHOR_TRAILER,
  resolveGitWorkflowConfig,
  type ResolvedConfig,
} from "../../config/schema"
import { runGit as defaultRunGit, type ExecResult } from "../../agent/run-git"
import { generateText } from "../../agent/generate-text"
import { errorMessage } from "./shared"
import type { TuiAction } from "../state/types"

/** The default trailer generated commits end with (re-exported for tests /
 * callers; the active value comes from `config.git.coauthorTrailer`). */
export const COAUTHOR_TRAILER = DEFAULT_COAUTHOR_TRAILER

/** Cap the diff fed to the model — the message only needs the shape of the change. */
const MAX_DIFF_CHARS = 12_000

export interface CommitDeps {
  dispatch: (action: TuiAction) => void
  cwd: string
  /** The verb: "" / "run" | "stage-all" | "apply" | "cancel". */
  action?: string
  /** Resolved config — required to drive the generation model. */
  config?: ResolvedConfig
  /** Config home (`~/.cognia`) for the generation turn's transcript. */
  home?: string
  /** Pending staged commit message (read by `apply`). */
  commitDraft?: { message: string }
  /** Argv git runner (defaults to the real one; faked in tests). */
  runGit?: (args: string[], cwd: string) => Promise<ExecResult>
  /** Text generator (defaults to a locked-down headless turn; faked in tests). */
  generate?: (input: {
    prompt: string
    config: ResolvedConfig
    home?: string
    cwd: string
  }) => Promise<string>
}

export interface CommitPromptContext {
  diff: string
  changedFiles: string
  branch: string
}

/** Build the commit-message prompt. Pure, so its shape is unit-tested. */
export function buildCommitMessagePrompt(ctx: CommitPromptContext): string {
  const diff =
    ctx.diff.length > MAX_DIFF_CHARS
      ? `${ctx.diff.slice(0, MAX_DIFF_CHARS)}\n…(diff truncated)…`
      : ctx.diff
  return [
    "Write a Conventional Commit message for the following staged changes.",
    "",
    `Branch: ${ctx.branch}`,
    "Changed files:",
    ctx.changedFiles.trim() || "(none)",
    "",
    "Staged diff:",
    "```diff",
    diff.trim(),
    "```",
    "",
    "Requirements:",
    "- First line: `type(scope): subject` — type is one of feat, fix, docs, style, refactor, perf, test, build, ci, chore. Scope is optional. The description after the colon must be lowercase and imperative, and the whole first line must be 72 characters or fewer.",
    "- Then a blank line, then a body that wraps at 100 columns and explains WHAT changed and WHY (not how).",
    "- Output ONLY the commit message — no code fences, no commentary, and do NOT add a Co-Authored-By trailer (it is appended automatically).",
  ].join("\n")
}

/**
 * Append the configured co-author trailer as its own paragraph (idempotent).
 * `trailer: null` (config `coauthorTrailer: false`) appends nothing.
 */
export function formatCommitMessage(
  raw: string,
  trailer: string | null = DEFAULT_COAUTHOR_TRAILER
): string {
  const body = raw.trim()
  if (trailer === null) return `${body}\n`
  if (/Co-Authored-By:\s*Claude/i.test(body)) return `${body}\n`
  return `${body}\n\n${trailer}\n`
}

const gitOf = (deps: CommitDeps) =>
  deps.runGit ?? ((args: string[], cwd: string) => defaultRunGit(args, cwd))
const generateOf = (deps: CommitDeps) => deps.generate ?? generateText

async function currentBranch(deps: CommitDeps): Promise<{ branch: string } | { error: string }> {
  const git = gitOf(deps)
  const res = await git(["rev-parse", "--abbrev-ref", "HEAD"], deps.cwd)
  if (res.code !== 0) {
    return {
      error: `Not a git repository (or no commits yet): ${res.stderr.trim() || "git failed"}`,
    }
  }
  return { branch: res.stdout.trim() }
}

/** Generate the message, stage it, and open the confirm overlay. */
async function generateAndStage(deps: CommitDeps, branch: string): Promise<void> {
  if (!deps.config) {
    deps.dispatch({ type: "NOTICE", message: "/commit needs an active model config." })
    return
  }
  const git = gitOf(deps)
  const [diffRes, filesRes] = await Promise.all([
    git(["diff", "--cached"], deps.cwd),
    git(["diff", "--cached", "--name-only"], deps.cwd),
  ])

  deps.dispatch({ type: "NOTICE", message: "Writing a commit message from the staged diff…" })
  let raw: string
  try {
    raw = await generateOf(deps)({
      prompt: buildCommitMessagePrompt({
        diff: diffRes.stdout,
        changedFiles: filesRes.stdout,
        branch,
      }),
      config: deps.config,
      cwd: deps.cwd,
      ...(deps.home ? { home: deps.home } : {}),
    })
  } catch (err) {
    deps.dispatch({
      type: "NOTICE",
      message: `Commit-message generation failed: ${errorMessage(err)}`,
    })
    return
  }
  if (!raw.trim()) {
    deps.dispatch({ type: "NOTICE", message: "Model returned an empty commit message." })
    return
  }
  const message = formatCommitMessage(
    raw,
    resolveGitWorkflowConfig(deps.config?.git).coauthorTrailer
  )
  deps.dispatch({ type: "SET_COMMIT_DRAFT", message })
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "confirm",
      title: `Commit to ${branch}?`,
      body: message,
      format: "text",
      onConfirmCommand: "commit apply",
      onCancelCommand: "commit cancel",
    },
  })
}

/** Entry flow: branch guard → staged check → generate. */
async function runFlow(deps: CommitDeps): Promise<void> {
  const cur = await currentBranch(deps)
  if ("error" in cur) {
    deps.dispatch({ type: "NOTICE", message: cur.error })
    return
  }
  const protectedBranches = resolveGitWorkflowConfig(deps.config?.git).protectedBranches
  if (protectedBranches.includes(cur.branch)) {
    deps.dispatch({
      type: "NOTICE",
      message: `Refusing to commit directly to "${cur.branch}". Create a feature branch first (e.g. \`git checkout -b feature/…\`).`,
    })
    return
  }
  const git = gitOf(deps)
  // `git diff --cached --quiet` exits 0 when NOTHING is staged, 1 when there is.
  const staged = await git(["diff", "--cached", "--quiet"], deps.cwd)
  if (staged.code === 0) {
    deps.dispatch({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "confirm",
        title: "Nothing staged",
        body: "No staged changes. Stage all changes (`git add -A`) and commit?",
        format: "text",
        onConfirmCommand: "commit stage-all",
        onCancelCommand: "commit cancel",
      },
    })
    return
  }
  await generateAndStage(deps, cur.branch)
}

/** `stage-all`: `git add -A`, then re-enter the generate flow. */
async function runStageAll(deps: CommitDeps): Promise<void> {
  const git = gitOf(deps)
  const added = await git(["add", "-A"], deps.cwd)
  if (added.code !== 0) {
    deps.dispatch({
      type: "NOTICE",
      message: `git add failed: ${added.stderr.trim() || "unknown error"}`,
    })
    return
  }
  await runFlow(deps)
}

/** `apply`: create the commit with the staged draft (husky hooks run). */
async function runApply(deps: CommitDeps): Promise<void> {
  const draft = deps.commitDraft
  if (!draft) {
    deps.dispatch({ type: "NOTICE", message: "No pending commit to apply." })
    return
  }
  const git = gitOf(deps)
  const res = await git(["commit", "-m", draft.message], deps.cwd)
  deps.dispatch({ type: "CLEAR_COMMIT_DRAFT" })
  if (res.code !== 0) {
    const detail = (res.stderr.trim() || res.stdout.trim() || "git commit failed").slice(0, 2000)
    deps.dispatch({
      type: "NOTICE",
      message: `Commit rejected (the commit was NOT created — hooks/commitlint must pass, and --no-verify is never used):\n${detail}`,
    })
    return
  }
  deps.dispatch({
    type: "NOTICE",
    message: `Committed.\n${res.stdout.trim() || res.stderr.trim()}`,
  })
}

/** `cancel`: drop the pending draft (confirm-overlay Esc). */
function runCancel(deps: CommitDeps): void {
  if (deps.commitDraft) deps.dispatch({ type: "CLEAR_COMMIT_DRAFT" })
}

export async function runCommit(deps: CommitDeps): Promise<void> {
  const action = (deps.action ?? "").trim().toLowerCase()
  switch (action) {
    case "":
    case "run":
      return runFlow(deps)
    case "stage-all":
      return runStageAll(deps)
    case "apply":
      return runApply(deps)
    case "cancel":
      return runCancel(deps)
    default:
      deps.dispatch({ type: "NOTICE", message: `Unknown /commit action "${action}".` })
  }
}
