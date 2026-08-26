/**
 * `/pr` controller — summarize the branch's commits vs the base branch into a PR
 * title + body, confirm, then open a draft PR with `gh`.
 *
 * Same generate → stage-draft → confirm → apply shape as `/commit`, reusing the
 * argv exec seam (`run-git`) and the locked-down text turn (`generate-text`).
 * Draft-first always (`gh pr create --draft`); if `gh` is missing we fall back to
 * a document overlay with the drafted title/body + manual instructions rather
 * than failing silently.
 *
 * Git safety: base is auto-detected (main → master); a PR is refused when the
 * current branch IS the base. CLI is English-only.
 */
import {
  DEFAULT_PR_FOOTER,
  resolveGitWorkflowConfig,
  type ResolvedConfig,
} from "../../config/schema"
import { runGit as defaultRunGit, runExec, type ExecFn, type ExecResult } from "../../agent/run-git"
import { generateText } from "../../agent/generate-text"
import { errorMessage, openDocument } from "./shared"
import type { TuiAction } from "../state/types"

/** Base branches to try, in order (when `config.git.baseBranch` is not set). */
const BASE_CANDIDATES = ["main", "master"] as const

/** The default PR-body footer (re-exported for tests / callers; the active
 * value comes from `config.git.prFooter`). */
export const PR_FOOTER = DEFAULT_PR_FOOTER

export interface PrDeps {
  dispatch: (action: TuiAction) => void
  cwd: string
  /** The verb: "" / "run" | "apply" | "cancel". */
  action?: string
  config?: ResolvedConfig
  home?: string
  /** Pending PR draft (read by `apply`). */
  prDraft?: { title: string; body: string; base: string }
  /** Argv git runner (defaults to the real one; faked in tests). */
  runGit?: (args: string[], cwd: string) => Promise<ExecResult>
  /** `gh` runner (defaults to `runExec("gh", …)`; faked in tests). */
  runGh?: (args: string[]) => Promise<ExecResult>
  /** Text generator (defaults to a locked-down headless turn; faked in tests). */
  generate?: (input: {
    prompt: string
    config: ResolvedConfig
    home?: string
    cwd: string
  }) => Promise<string>
}

export interface PrPromptContext {
  commits: string
  diffstat: string
  base: string
  branch: string
}

/** Build the PR-summary prompt. Pure, so its shape is unit-tested. */
export function buildPrSummaryPrompt(ctx: PrPromptContext): string {
  return [
    `Summarize this branch (\`${ctx.branch}\`) into a pull request against \`${ctx.base}\`.`,
    "",
    "Commits:",
    ctx.commits.trim() || "(none)",
    "",
    "Diffstat:",
    ctx.diffstat.trim() || "(none)",
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
  ].join("\n")
}

/** Split the model's `Title:` / `Body:` output. Pure. */
export function parsePrDraft(text: string): { title: string; body: string } {
  const trimmed = text.trim()
  const titleMatch = /^\s*Title:\s*(.+)$/im.exec(trimmed)
  const bodyMatch = /^\s*Body:\s*$([\s\S]*)/im.exec(trimmed)
  if (titleMatch) {
    const title = titleMatch[1].trim()
    let body = ""
    if (bodyMatch) {
      body = bodyMatch[1].trim()
    } else {
      // Body on the same block after the title line.
      body = trimmed.slice(trimmed.indexOf(titleMatch[0]) + titleMatch[0].length).trim()
    }
    return { title, body }
  }
  // Fallback: first line is the title, the rest is the body.
  const [first, ...rest] = trimmed.split("\n")
  return { title: first.trim(), body: rest.join("\n").trim() }
}

/**
 * Append the configured PR footer to a body (idempotent). `footer: null`
 * (config `prFooter: false`) appends nothing.
 */
export function formatPrBody(body: string, footer: string | null = DEFAULT_PR_FOOTER): string {
  const b = body.trim()
  if (footer === null) return b
  if (b.includes(footer)) return b
  return `${b}\n\n${footer}`
}

const gitOf = (deps: PrDeps) =>
  deps.runGit ?? ((args: string[], cwd: string) => defaultRunGit(args, cwd))
const ghOf = (deps: PrDeps) =>
  deps.runGh ?? ((args: string[]) => (runExec as ExecFn)("gh", args, { cwd: deps.cwd }))
const generateOf = (deps: PrDeps) => deps.generate ?? generateText

/**
 * Detect the PR base branch.
 *
 * A recorded stack parent wins outright. That is the whole content of a
 * stacked pull request — layer *n*'s base is layer *n-1* — so opening this one
 * against the trunk instead would put every commit below it in the diff and
 * quietly undo the stack `/stack on` was used to build. The pointer is only
 * honoured when the parent branch actually exists; a stale pointer to a merged
 * and deleted branch falls through to the trunk rather than producing a pull
 * request the forge rejects.
 *
 * Otherwise the `config.git.baseBranch` override when it exists in the repo,
 * else the first of main → master that does.
 */
async function detectBase(deps: PrDeps, branch?: string): Promise<string | null> {
  const git = gitOf(deps)
  if (branch) {
    const recorded = await git(["config", "--get", `branch.${branch}.cognia-parent`], deps.cwd)
    const parent = recorded.code === 0 ? recorded.stdout.trim() : ""
    if (parent && parent !== branch) {
      const exists = await git(["rev-parse", "--verify", "--quiet", parent], deps.cwd)
      if (exists.code === 0) return parent
    }
  }
  const override = resolveGitWorkflowConfig(deps.config?.git).baseBranch
  const candidates = override ? [override] : [...BASE_CANDIDATES]
  for (const candidate of candidates) {
    const res = await git(["rev-parse", "--verify", "--quiet", candidate], deps.cwd)
    if (res.code === 0) return candidate
  }
  return null
}

async function runFlow(deps: PrDeps): Promise<void> {
  if (!deps.config) {
    deps.dispatch({ type: "NOTICE", message: "/pr needs an active model config." })
    return
  }
  const git = gitOf(deps)
  // The branch is read first: its recorded stack parent, when it has one, IS
  // the base of this pull request.
  const branchRes = await git(["rev-parse", "--abbrev-ref", "HEAD"], deps.cwd)
  const branch = branchRes.stdout.trim()
  const base = await detectBase(deps, branch)
  if (!base) {
    const override = resolveGitWorkflowConfig(deps.config?.git).baseBranch
    deps.dispatch({
      type: "NOTICE",
      message: override
        ? `Configured base branch "${override}" (config.git.baseBranch) not found in this repo.`
        : "No `main` or `master` base branch found in this repo.",
    })
    return
  }
  if (branch === base) {
    deps.dispatch({
      type: "NOTICE",
      message: `You're on the base branch "${base}". Check out a feature branch before opening a PR.`,
    })
    return
  }
  const range = `${base}..HEAD`
  const [commitsRes, statRes] = await Promise.all([
    git(["log", range, "--format=- %s%n%b"], deps.cwd),
    git(["diff", "--stat", range], deps.cwd),
  ])
  if (!commitsRes.stdout.trim()) {
    deps.dispatch({ type: "NOTICE", message: `No commits on "${branch}" vs "${base}".` })
    return
  }

  deps.dispatch({ type: "NOTICE", message: `Summarizing ${branch} → ${base} into a PR…` })
  let raw: string
  try {
    raw = await generateOf(deps)({
      prompt: buildPrSummaryPrompt({
        commits: commitsRes.stdout,
        diffstat: statRes.stdout,
        base,
        branch,
      }),
      config: deps.config,
      cwd: deps.cwd,
      ...(deps.home ? { home: deps.home } : {}),
    })
  } catch (err) {
    deps.dispatch({ type: "NOTICE", message: `PR summary generation failed: ${errorMessage(err)}` })
    return
  }
  const parsed = parsePrDraft(raw)
  if (!parsed.title) {
    deps.dispatch({ type: "NOTICE", message: "Model returned no PR title." })
    return
  }
  const body = formatPrBody(parsed.body, resolveGitWorkflowConfig(deps.config?.git).prFooter)
  deps.dispatch({ type: "SET_PR_DRAFT", title: parsed.title, body, base })
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "confirm",
      title: `Open draft PR into ${base}?`,
      body: `${parsed.title}\n\n${body}`,
      format: "markdown",
      onConfirmCommand: "pr apply",
      onCancelCommand: "pr cancel",
    },
  })
}

/** Fall back to a document overlay when `gh` is unavailable. */
function showManualPr(deps: PrDeps, draft: { title: string; body: string; base: string }): void {
  openDocument(deps.dispatch, {
    title: "PR draft (gh not found)",
    body: [
      "`gh` (GitHub CLI) is not installed or not on PATH — here is the drafted PR.",
      "Push your branch and create the PR manually, e.g.:",
      "",
      "```",
      `git push -u origin HEAD`,
      `gh pr create --draft --base ${draft.base} --title "…" --body "…"`,
      "```",
      "",
      `## ${draft.title}`,
      "",
      draft.body,
    ].join("\n"),
    format: "markdown",
  })
}

async function runApply(deps: PrDeps): Promise<void> {
  const draft = deps.prDraft
  if (!draft) {
    deps.dispatch({ type: "NOTICE", message: "No pending PR to open." })
    return
  }
  const gh = ghOf(deps)
  const version = await gh(["--version"])
  if (version.code !== 0) {
    showManualPr(deps, draft)
    deps.dispatch({ type: "CLEAR_PR_DRAFT" })
    return
  }
  const res = await gh([
    "pr",
    "create",
    "--draft",
    "--base",
    draft.base,
    "--title",
    draft.title,
    "--body",
    draft.body,
  ])
  deps.dispatch({ type: "CLEAR_PR_DRAFT" })
  if (res.code !== 0) {
    deps.dispatch({
      type: "NOTICE",
      message: `gh pr create failed:\n${(res.stderr.trim() || res.stdout.trim() || "unknown error").slice(0, 2000)}`,
    })
    return
  }
  deps.dispatch({ type: "NOTICE", message: `Draft PR opened.\n${res.stdout.trim()}` })
}

function runCancel(deps: PrDeps): void {
  if (deps.prDraft) deps.dispatch({ type: "CLEAR_PR_DRAFT" })
}

export async function runPr(deps: PrDeps): Promise<void> {
  const action = (deps.action ?? "").trim().toLowerCase()
  switch (action) {
    case "":
    case "run":
      return runFlow(deps)
    case "apply":
      return runApply(deps)
    case "cancel":
      return runCancel(deps)
    default:
      deps.dispatch({ type: "NOTICE", message: `Unknown /pr action "${action}".` })
  }
}
