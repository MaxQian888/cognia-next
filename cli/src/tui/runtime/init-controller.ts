/**
 * `/init` controller — manage the project instruction file (`AGENTS.md`) for the
 * built-in agent (desktop + CLI both load it via `lib/claude/instructions`).
 *
 * Actions (routed by the runtime `arg`):
 *   • (bare / `run`) — create `AGENTS.md` from a template when no instruction
 *     file exists; otherwise open a menu of the actions below.
 *   • `create` / `regenerate` — (re)generate the template; overwrite only after
 *     a confirm overlay.
 *   • `rewrite` / `optimize` — ask the active model to rewrite `AGENTS.md` using
 *     bounded project context, then confirm before overwriting.
 *   • `preview` — open the current `AGENTS.md` in a read-only pager.
 *   • `scaffold` — seed `.cognia/instructions/*.md` + `.cognia/agents/example.md`.
 *   • `apply` — write the pending draft staged by create/rewrite.
 *
 * All fs + model effects are injectable so the controller unit-tests without a
 * real filesystem or sidecar.
 */
import fs from "node:fs"
import path from "node:path"

import {
  resolveSendOptions as defaultResolveSendOptions,
  type BuildOptionsContext,
} from "@/lib/claude/build-options"
import type { SendOptions } from "@cognia/agent-config-types"

import { runHeadlessTurn } from "../../agent/run"
import { createPermissionGate } from "../../agent/permission-gate"
import type { ResolvedConfig } from "../../config/schema"
import { errorMessage, openDocument } from "./shared"
import type { TuiAction } from "../state/types"

/** Instruction filenames the agent discovers, in precedence order. */
export const INSTRUCTION_FILENAMES = ["AGENTS.md", "AGENT.md", "CLAUDE.md"] as const

/** A minimal, fill-in-the-blanks AGENTS.md body. */
export function agentsTemplate(projectName: string): string {
  return [
    `# ${projectName}`,
    "",
    "## Project overview",
    "",
    "<!-- One paragraph: what this project is and its stack. -->",
    "",
    "## Tech stack",
    "",
    "- <!-- languages, frameworks, package manager, build tooling -->",
    "",
    "## Conventions",
    "",
    "- <!-- coding standards, naming, formatting, file layout -->",
    "",
    "## Commands",
    "",
    "- Build:",
    "- Test:",
    "- Lint:",
    "",
    "## Notes for the agent",
    "",
    "- <!-- anything the agent should always keep in mind -->",
    "",
  ].join("\n")
}

/** Starter bodies for the files `/init scaffold` seeds. Keyed by relative path. */
export function scaffoldFiles(projectName: string): Record<string, string> {
  return {
    ".cognia/instructions/stack.md": [
      "# Tech stack",
      "",
      "<!-- Languages, frameworks, package manager, and build tooling. -->",
      "",
    ].join("\n"),
    ".cognia/instructions/commands.md": [
      "# Commands",
      "",
      "- Build:",
      "- Test:",
      "- Lint:",
      "",
    ].join("\n"),
    ".cognia/instructions/conventions.md": [
      "# Conventions",
      "",
      "<!-- Coding standards, naming, formatting, file layout. -->",
      "",
    ].join("\n"),
    ".cognia/agents/example.md": [
      "---",
      "description: An example custom subagent. Rename and edit to taste.",
      "tools: read, grep, glob",
      "---",
      "",
      `You are a focused helper for the ${projectName} project.`,
      "Describe the subagent's job, scope, and output format here.",
      "",
    ].join("\n"),
  }
}

/** Bounded project context fed to the rewrite model. */
export interface RewriteContext {
  projectName: string
  current: string
  scripts: string[]
  deps: string[]
  dirs: string[]
  readme: string
}

/** Build the rewrite prompt. Pure, so its shape is unit-tested. */
export function buildRewritePrompt(ctx: RewriteContext): string {
  return [
    `You are editing the project instruction file AGENTS.md for "${ctx.projectName}".`,
    "",
    "Current AGENTS.md:",
    "---",
    ctx.current.trim() || "(empty)",
    "---",
    "",
    "Project context:",
    `- Scripts: ${ctx.scripts.join(", ") || "(none found)"}`,
    `- Dependencies: ${ctx.deps.join(", ") || "(none found)"}`,
    `- Top-level dirs: ${ctx.dirs.join(", ") || "(none found)"}`,
    "- README excerpt:",
    ctx.readme.trim() || "(none found)",
    "",
    "Rewrite AGENTS.md to be clear, complete, and useful for an AI coding assistant.",
    "Include these sections: Project overview, Tech stack, Commands, Conventions, Notes for the agent.",
    "Output ONLY the markdown content; do not wrap it in a code block or add commentary.",
  ].join("\n")
}

/** The fs surface the controller needs — all injectable. */
export interface InitFs {
  exists(p: string): boolean
  read(p: string): string
  write(p: string, content: string): void
  mkdir(p: string): void
  readdir(p: string): string[]
}

/** The real Node filesystem implementation (exported for the round-trip test). */
export const NODE_FS: InitFs = {
  exists: (p) => fs.existsSync(p),
  read: (p) => fs.readFileSync(p, "utf8"),
  write: (p, c) => fs.writeFileSync(p, c, "utf8"),
  mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
  readdir: (p) => fs.readdirSync(p),
}

export interface InitDeps {
  dispatch: (action: TuiAction) => void
  cwd: string
  /** The verb (`create` / `rewrite` / `preview` / `scaffold` / `apply`); bare
   * `run` or undefined runs the create-or-menu flow. */
  action?: string
  /** Config home (`~/.cognia`) for the rewrite turn's transcript. */
  home?: string
  /** Resolved config — required for `rewrite` (drives provider/model). */
  config?: ResolvedConfig
  /** The pending staged draft (read by `apply`). */
  initDraft?: { target: string; content: string }
  /** Injectable filesystem. Defaults to {@link NODE_FS}. */
  fsApi?: Partial<InitFs>
  /** Run the locked-down rewrite turn. Defaults to {@link defaultRewrite}. */
  rewriteWithModel?: (input: {
    prompt: string
    config: ResolvedConfig
    home?: string
    cwd: string
  }) => Promise<string>
  /** Build the rewrite prompt. Defaults to {@link buildRewritePrompt}. */
  buildPrompt?: (ctx: RewriteContext) => string
}

function fsOf(deps: InitDeps): InitFs {
  return { ...NODE_FS, ...deps.fsApi }
}

function projectNameOf(cwd: string): string {
  return path.basename(cwd) || "Project"
}

/** The first existing instruction file in cwd (AGENTS.md/AGENT.md/CLAUDE.md). */
function presentInstructionFile(cwd: string, io: InitFs): string | undefined {
  return INSTRUCTION_FILENAMES.find((f) => io.exists(path.join(cwd, f)))
}

/**
 * Lock down the resolved send options for the rewrite turn: strip every tool and
 * bypass approvals, so the rewrite model can only return text — it can't edit
 * files or trigger a mid-turn prompt. Exported for unit testing.
 */
export async function lockdownRewriteOptions(
  ctx: BuildOptionsContext,
  resolve: (ctx: BuildOptionsContext) => Promise<SendOptions> = defaultResolveSendOptions
): Promise<SendOptions> {
  const opts = await resolve(ctx)
  return { ...opts, allowedTools: [], permissionMode: "bypassPermissions" }
}

/** Default rewrite turn: one locked-down headless turn (no tools, no prompts). */
async function defaultRewrite(input: {
  prompt: string
  config: ResolvedConfig
  home?: string
  cwd: string
}): Promise<string> {
  const result = await runHeadlessTurn({
    config: { ...input.config, cwd: input.cwd },
    prompt: input.prompt,
    gate: createPermissionGate({ yes: false }),
    resolveOptions: (ctx: BuildOptionsContext) => lockdownRewriteOptions(ctx),
    timeoutMs: 60_000,
    ...(input.home ? { home: input.home } : {}),
  })
  return result.text
}

/** Read bounded project context for the rewrite prompt — best-effort. */
export function gatherProjectContext(cwd: string, io: InitFs): Omit<RewriteContext, "current"> {
  const projectName = projectNameOf(cwd)

  let scripts: string[] = []
  let deps: string[] = []
  try {
    const pkg = JSON.parse(io.read(path.join(cwd, "package.json"))) as {
      scripts?: Record<string, unknown>
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    scripts = Object.keys(pkg.scripts ?? {}).slice(0, 30)
    deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ].slice(0, 40)
  } catch {
    // no package.json / unparseable — leave empty
  }

  let readme = ""
  try {
    readme = io.read(path.join(cwd, "README.md")).slice(0, 1200)
  } catch {
    // no README — leave empty
  }

  const IGNORED = new Set(["node_modules", ".git", "out", "dist", ".next"])
  let dirs: string[] = []
  try {
    dirs = io
      .readdir(cwd)
      .filter((n) => !n.startsWith(".") || n === ".cognia")
      .filter((n) => !IGNORED.has(n))
      .slice(0, 40)
  } catch {
    // unreadable cwd — leave empty
  }

  return { projectName, scripts, deps, dirs, readme }
}

/** Stage a draft for confirmation: persist it + open the confirm overlay. */
function stageDraft(deps: InitDeps, target: string, content: string, title: string): void {
  deps.dispatch({ type: "SET_INIT_DRAFT", target, content })
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "confirm",
      title,
      body: content,
      format: "markdown",
      onConfirmCommand: "init apply",
      onCancelCommand: "init cancel",
    },
  })
}

function openMenu(deps: InitDeps): void {
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: "AGENTS.md exists — choose an action",
      items: [
        {
          id: "create",
          label: "Regenerate AGENTS.md template",
          hint: "overwrite with the starter",
        },
        {
          id: "rewrite",
          label: "Rewrite with the current model",
          hint: "AI-improved, confirm first",
        },
        { id: "preview", label: "Preview current AGENTS.md", hint: "read-only" },
        {
          id: "scaffold",
          label: "Scaffold .cognia/instructions + agents",
          hint: "split instruction files",
        },
      ],
      index: 0,
      onSelectCommand: "init",
    },
  })
}

/** Create `AGENTS.md` from the template, or open the menu when one exists. */
function runMenuOrCreate(deps: InitDeps): void {
  const io = fsOf(deps)
  const present = presentInstructionFile(deps.cwd, io)
  if (present) {
    openMenu(deps)
    return
  }
  writeNew(deps, io)
}

/** Write a fresh AGENTS.md (no existing instruction file). */
function writeNew(deps: InitDeps, io: InitFs): void {
  const target = path.join(deps.cwd, "AGENTS.md")
  try {
    io.write(target, agentsTemplate(projectNameOf(deps.cwd)))
  } catch (err) {
    deps.dispatch({ type: "NOTICE", message: `Could not write AGENTS.md: ${errorMessage(err)}` })
    return
  }
  deps.dispatch({
    type: "NOTICE",
    message: `Created ${target} — fill it in and the agent will load it next turn.`,
  })
}

/** `create` / `regenerate`: stage the template (confirm if AGENTS.md exists). */
function runCreate(deps: InitDeps): void {
  const io = fsOf(deps)
  const target = path.join(deps.cwd, "AGENTS.md")
  const content = agentsTemplate(projectNameOf(deps.cwd))
  if (io.exists(target)) {
    stageDraft(deps, target, content, "Regenerate AGENTS.md — overwrite?")
    return
  }
  writeNew(deps, io)
}

/** `rewrite` / `optimize`: ask the model, then stage for confirmation. */
async function runRewrite(deps: InitDeps): Promise<void> {
  const io = fsOf(deps)
  const target = path.join(deps.cwd, "AGENTS.md")
  if (!io.exists(target)) {
    deps.dispatch({
      type: "NOTICE",
      message: "No AGENTS.md to rewrite. Run /init create first.",
    })
    return
  }
  if (!deps.config) {
    deps.dispatch({ type: "NOTICE", message: "Rewrite needs an active model config." })
    return
  }
  const current = io.read(target)
  const ctx: RewriteContext = { current, ...gatherProjectContext(deps.cwd, io) }
  const prompt = (deps.buildPrompt ?? buildRewritePrompt)(ctx)
  const rewrite = deps.rewriteWithModel ?? defaultRewrite
  deps.dispatch({ type: "NOTICE", message: "Rewriting AGENTS.md with the current model…" })
  let text: string
  try {
    text = await rewrite({ prompt, config: deps.config, home: deps.home, cwd: deps.cwd })
  } catch (err) {
    deps.dispatch({ type: "CLEAR_INIT_DRAFT" })
    deps.dispatch({ type: "NOTICE", message: `Rewrite failed: ${errorMessage(err)}` })
    return
  }
  const body = text.trim()
  if (!body) {
    deps.dispatch({
      type: "NOTICE",
      message: "Model returned an empty rewrite; nothing to apply.",
    })
    return
  }
  stageDraft(deps, target, body, "Proposed AGENTS.md rewrite — overwrite?")
}

/** `preview`: open the current AGENTS.md in the read-only pager. */
function runPreview(deps: InitDeps): void {
  const io = fsOf(deps)
  const target = path.join(deps.cwd, "AGENTS.md")
  if (!io.exists(target)) {
    deps.dispatch({ type: "NOTICE", message: "No AGENTS.md to preview. Run /init create first." })
    return
  }
  let body: string
  try {
    body = io.read(target)
  } catch (err) {
    deps.dispatch({ type: "NOTICE", message: `Could not read AGENTS.md: ${errorMessage(err)}` })
    return
  }
  openDocument(deps.dispatch, {
    title: `AGENTS.md · ${projectNameOf(deps.cwd)}`,
    body,
    format: "markdown",
  })
}

/** `scaffold`: seed `.cognia/instructions/*.md` + `.cognia/agents/example.md`. */
function runScaffold(deps: InitDeps): void {
  const io = fsOf(deps)
  const files = scaffoldFiles(projectNameOf(deps.cwd))
  const created: string[] = []
  const skipped: string[] = []
  const failed: string[] = []
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(deps.cwd, rel)
    if (io.exists(abs)) {
      skipped.push(rel)
      continue
    }
    try {
      io.mkdir(path.dirname(abs))
      io.write(abs, content)
      created.push(rel)
    } catch {
      failed.push(rel)
    }
  }
  const parts: string[] = []
  if (created.length) parts.push(`Created: ${created.join(", ")}`)
  if (skipped.length) parts.push(`Skipped (exist): ${skipped.join(", ")}`)
  if (failed.length) parts.push(`Failed: ${failed.join(", ")}`)
  deps.dispatch({
    type: "NOTICE",
    message: parts.length ? parts.join(" · ") : "Nothing to scaffold.",
  })
}

/** `apply`: write the pending draft staged by create/rewrite. */
function runApply(deps: InitDeps): void {
  const draft = deps.initDraft
  if (!draft) {
    deps.dispatch({ type: "NOTICE", message: "No pending init change to apply." })
    return
  }
  const io = fsOf(deps)
  try {
    io.write(draft.target, draft.content)
  } catch (err) {
    deps.dispatch({
      type: "NOTICE",
      message: `Could not write ${draft.target}: ${errorMessage(err)}`,
    })
    return
  }
  deps.dispatch({ type: "CLEAR_INIT_DRAFT" })
  deps.dispatch({ type: "NOTICE", message: `Updated ${draft.target}.` })
}

/** `cancel`: discard the pending draft (confirm-overlay Esc). */
function runCancel(deps: InitDeps): void {
  if (deps.initDraft) deps.dispatch({ type: "CLEAR_INIT_DRAFT" })
}

export async function runInit(deps: InitDeps): Promise<void> {
  const action = (deps.action ?? "").trim().toLowerCase()
  switch (action) {
    case "":
    case "run":
      return runMenuOrCreate(deps)
    case "create":
    case "regenerate":
      return runCreate(deps)
    case "rewrite":
    case "optimize":
      return runRewrite(deps)
    case "preview":
      return runPreview(deps)
    case "scaffold":
      return runScaffold(deps)
    case "apply":
      return runApply(deps)
    case "cancel":
      return runCancel(deps)
    default:
      deps.dispatch({
        type: "NOTICE",
        message: `Unknown /init action "${action}". Try: create, rewrite, preview, scaffold.`,
      })
  }
}
