/**
 * `/agents` controller — list `.cognia/agents/*.md` subagents and dispatch one
 * by reusing `dispatchSubagent` (renderer-store-free → works in the CLI). File
 * discovery + the dispatcher are injectable for tests.
 */
import nodeFs from "node:fs/promises"
import path from "node:path"

import { dispatchSubagent } from "@/lib/plugin/agent-sdk/dispatch"
import { serializeMarkdownAgent } from "@/lib/claude/agents/markdown-agents"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import { listBackgroundTaskRecords } from "@/lib/db/background-tasks"
import type { BackgroundTaskJournalRecord } from "@/lib/background-tasks/registry-core"

import {
  applySubagentModelOverrides,
  discoverDispatchableAgents,
  type AgentSummary,
} from "../../agent/discover-agents"
import { withBuiltinAgents } from "../../agent/builtin-agents"
import { buildSubagentModelRows } from "./subagent-models-model"
import type { ResolvedConfig } from "../../config/schema"
import {
  listCliBackgroundRuns,
  cancelCliBackgroundRun,
  hasCliBackgroundRun,
  startCliBackgroundRun,
  type CliBackgroundRunInfo,
} from "../../agent/subagent-background-tasks"
import {
  applyLiveSubagentEvent,
  listLiveSubagents,
  settleLiveSubagent,
  startLiveSubagent,
  type SubagentLiveEntry,
} from "../../agent/subagent-live-output"
import type { CommandEffect } from "../commands/types"
import { buildAgentPanelRows } from "./agents-panel-model"
import { errorMessage, truncate } from "./shared"
import type { InflightSubagentRow } from "../format/subagent"
import type { TuiAction } from "../state/types"

export interface AgentsDeps {
  dispatch: (action: TuiAction) => void
  cwd: string
  /** Discovery roots (project + home). Defaults to `[cwd]`. */
  roots?: string[]
  signal?: AbortSignal
  /** Per-subagent provider/model overrides (`config.subagentModels`) overlaid
   * onto the discovered set, so a `/agents models` choice wins at dispatch. */
  subagentModels?: ResolvedConfig["subagentModels"]
  /** The chat session that owns a manual run (live entry + background journal
   * scoping). Omitted ⇒ the run is filed under a generic owner. */
  sessionId?: string
  /** Config home, where the background journal lives. */
  home?: string
  list?: () => Promise<AgentSummary[]>
  dispatchAgent?: (
    def: PluginSubagentDef,
    prompt: string,
    opts: {
      cwd?: string
      abortSignal?: AbortSignal
      onEvent?: (event: CaptureStreamEvent) => void
    }
  ) => Promise<SubagentRunResult>
  /** Background-run seams, injectable for tests. */
  startBackground?: typeof startCliBackgroundRun
  hasBackground?: typeof hasCliBackgroundRun
  /** Mint a background run id (tests). */
  mintRunId?: () => string
}

/** Owner a manual run is filed under when no chat session id is known. */
const MANUAL_RUN_OWNER = "cli"

function defaultMintRunId(): string {
  try {
    return `bg-${crypto.randomUUID().slice(0, 8)}`
  } catch {
    return `bg-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  }
}

/** `/agents run [--bg] <id> <prompt>` argument parse. */
export function parseAgentsRunArgs(arg: string): {
  background: boolean
  id: string
  prompt: string
} {
  let rest = arg.trim()
  let background = false
  for (;;) {
    const m = /^(--bg|--background)(\s+|$)/.exec(rest)
    if (!m) break
    background = true
    rest = rest.slice(m[0].length).trim()
  }
  const space = rest.indexOf(" ")
  const id = space === -1 ? rest : rest.slice(0, space)
  const prompt = space === -1 ? "" : rest.slice(space + 1).trim()
  return { background, id, prompt }
}

/**
 * The subset of `PluginSubagentDispatchResult` the `/agents run` summary surfaces.
 * Kept structural (not the full type) so the injectable test dispatcher can return
 * just `{ text }` while the real {@link dispatchSubagent} (a superset) still fits.
 */
type SubagentRunResult = {
  text: string
  usage?: { totalTokens: number }
  finishReason?: string
  /** Set (never thrown) when a nesting guard refused the dispatch. */
  rejection?: { reason: string; message: string }
}

async function loadAgents(deps: AgentsDeps): Promise<AgentSummary[]> {
  const base = deps.list
    ? await deps.list()
    : withBuiltinAgents(await discoverDispatchableAgents(deps.roots ?? [deps.cwd]))
  return applySubagentModelOverrides(base, deps.subagentModels)
}

export async function agentsList(deps: AgentsDeps): Promise<void> {
  if (deps.signal?.aborted) return
  let agents: AgentSummary[]
  try {
    agents = await loadAgents(deps)
  } catch (error) {
    if (!deps.signal?.aborted)
      deps.dispatch({
        type: "NOTICE",
        message: `Subagent discovery failed: ${errorMessage(error)}`,
      })
    return
  }
  if (deps.signal?.aborted) return
  if (agents.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message: "No subagents found. Add markdown files under .cognia/agents/.",
    })
    return
  }
  const lines = agents.map((a) => `  ${a.name}${a.description ? ` — ${a.description}` : ""}`)
  deps.dispatch({
    type: "NOTICE",
    message: `Subagents:\n${lines.join("\n")}\n\nRun one: /agents run <id> <prompt>`,
  })
}

export interface AgentsPanelDeps {
  signal?: AbortSignal
  dispatch: (action: TuiAction) => void
  /** In-turn sub-agent dispatches still running (from `state.inflight.tools`). */
  inflight: InflightSubagentRow[]
  /** The current chat session — scopes the background runs/records shown so the
   * panel never surfaces another session's (or a `/clear`ed session's) runs.
   * Omitted ⇒ no scoping (tests / legacy callers see everything). */
  sessionId?: string
  /** Per-subagent live-output entries — injectable for tests. */
  liveSubagents?: () => SubagentLiveEntry[]
  /** Live CLI background runs — injectable for tests. */
  liveRuns?: () => CliBackgroundRunInfo[]
  /** Journaled CLI background records — injectable for tests. */
  journal?: () => Promise<BackgroundTaskJournalRecord[]>
}

/**
 * Open the interactive agents panel: merge the in-turn dispatches with the
 * background runs (live registry + journal) into one row list and hand it to the
 * `agents` overlay. Opens even when empty — the panel's empty state is itself
 * the "nothing running" affordance (mirrors `/mcp`).
 */
export async function agentsPanel(deps: AgentsPanelDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const owner = deps.sessionId
  const live = (deps.liveSubagents ?? (() => listLiveSubagents(owner)))()
  const backgroundRuns = (deps.liveRuns ?? (() => listCliBackgroundRuns(owner)))()
  const allRecords = await (deps.journal ?? (() => listBackgroundTaskRecords({ host: "cli" })))()
  if (deps.signal?.aborted) return
  const journalRecords =
    owner === undefined ? allRecords : allRecords.filter((r) => r.sessionId === owner)
  const rows = buildAgentPanelRows({
    inflight: deps.inflight,
    live,
    backgroundRuns,
    journalRecords,
  })
  deps.dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "agents", rows } })
}

export interface AgentsModelsPanelDeps {
  signal?: AbortSignal
  dispatch: (action: TuiAction) => void
  cwd: string
  /** Discovery roots (project + home). Defaults to `[cwd]`. */
  roots?: string[]
  /** The live resolved config — supplies the active provider, the per-provider
   * model catalog, and the persisted `subagentModels` overrides. */
  config: ResolvedConfig
  /** Raw discovered agents (overrides NOT overlaid) — injectable for tests. */
  list?: () => Promise<AgentSummary[]>
}

/**
 * Open the `/agents models` panel: discover the subagents (RAW — overrides are
 * read from config by the row builder, not pre-applied, so a row can tell an
 * override from frontmatter) and project them into editable rows. Opens even
 * when only the built-in `general-purpose` agent exists.
 */
export async function agentsModelsPanel(deps: AgentsModelsPanelDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const base = deps.list
    ? await deps.list()
    : withBuiltinAgents(await discoverDispatchableAgents(deps.roots ?? [deps.cwd]))
  if (deps.signal?.aborted) return
  const rows = buildSubagentModelRows(base, deps.config)
  deps.dispatch({ type: "OVERLAY_OPEN", overlay: { kind: "subagentModels", rows, index: 0 } })
}

export async function agentsDispatch(arg: string, deps: AgentsDeps): Promise<void> {
  if (deps.signal?.aborted) return
  const { background, id, prompt } = parseAgentsRunArgs(arg)
  if (!id || !prompt) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /agents run [--bg] <id> <prompt>" })
    return
  }
  let agents: AgentSummary[]
  try {
    agents = await loadAgents(deps)
  } catch (error) {
    if (!deps.signal?.aborted)
      deps.dispatch({
        type: "NOTICE",
        message: `Subagent discovery failed: ${errorMessage(error)}`,
      })
    return
  }
  if (deps.signal?.aborted) return
  const match = agents.find((a) => a.id === id)
  if (!match) {
    deps.dispatch({
      type: "NOTICE",
      message: `Unknown subagent "${id}". Try /agents to list them.`,
    })
    return
  }
  const run = deps.dispatchAgent ?? ((def, p, opts) => dispatchSubagent(def, p, opts))
  const owner = deps.sessionId ?? MANUAL_RUN_OWNER

  /** Run once, streaming into a live entry so the panel and run page see it. */
  const execute = async (
    liveId: string | undefined,
    signal: AbortSignal | undefined
  ): Promise<{ outcome: "done" | "interrupted" | "refused" | "error"; summary: string }> => {
    const live = startLiveSubagent({
      ...(liveId ? { liveId } : {}),
      name: id,
      task: prompt,
      sessionId: owner,
      depth: 1,
      ...(match.def.color ? { color: match.def.color } : {}),
    })
    let settled = false
    try {
      const result = await run(match.def, prompt, {
        cwd: deps.cwd,
        ...(signal ? { abortSignal: signal } : {}),
        onEvent: (event) => {
          if (!settled && !signal?.aborted) applyLiveSubagentEvent(live, event)
        },
      })
      if (signal?.aborted) {
        settleLiveSubagent(live, "interrupted")
        return { outcome: "interrupted", summary: `Subagent "${id}" interrupted.` }
      }
      // A nesting guard can refuse a dispatch (depth/cycle) by returning a result
      // with `rejection` set rather than throwing: surface it as an error end.
      if (result.rejection) {
        settleLiveSubagent(live, "error")
        return {
          outcome: "refused",
          summary: `Subagent "${id}" was refused (${result.rejection.reason}): ${result.rejection.message}`,
        }
      }
      // Enrich the summary with the token spend and a non-default finish reason
      // so the run reads like a delegated agent's result, not just a wall of text.
      const meta: string[] = []
      if (result.usage?.totalTokens) meta.push(`${result.usage.totalTokens} tok`)
      if (result.finishReason && result.finishReason !== "end_turn") meta.push(result.finishReason)
      const suffix = meta.length > 0 ? `  (${meta.join(" · ")})` : ""
      settleLiveSubagent(live, "done")
      return { outcome: "done", summary: `Subagent "${id}"${suffix}:\n${result.text}` }
    } catch (err) {
      if (signal?.aborted) {
        settleLiveSubagent(live, "interrupted")
        return { outcome: "interrupted", summary: `Subagent "${id}" interrupted.` }
      }
      settleLiveSubagent(live, "error")
      return { outcome: "error", summary: `Subagent "${id}" failed: ${errorMessage(err)}` }
    } finally {
      settled = true
    }
  }

  if (background) {
    // Detach: park the run in the background registry (journaled, owner-scoped,
    // stoppable from the panel or /agents stop) and return to the prompt now.
    const startBackground = deps.startBackground ?? startCliBackgroundRun
    const hasBackground = deps.hasBackground ?? hasCliBackgroundRun
    const runId = (deps.mintRunId ?? defaultMintRunId)()
    if (hasBackground(runId)) {
      deps.dispatch({ type: "NOTICE", message: `Background run id already exists: ${runId}.` })
      return
    }
    const controller = new AbortController()
    const onParentAbort = () => controller.abort(deps.signal?.reason)
    deps.signal?.addEventListener("abort", onParentAbort, { once: true })
    startBackground(
      runId,
      {
        kind: "subagent",
        subagentId: id,
        prompt,
        sessionId: owner,
        host: "cli",
        startedAt: Date.now(),
        mode: "background",
        toolsEnabled: true,
        ...(deps.home ? { home: deps.home } : {}),
      },
      // The background runId doubles as the live id so the panel shows one row.
      execute(runId, controller.signal)
        .then((r) => ({
          text: r.summary,
          ...(r.outcome === "error" || r.outcome === "refused" ? { error: r.summary } : {}),
          ...(r.outcome === "interrupted" ? { interrupted: true } : {}),
        }))
        .finally(() => deps.signal?.removeEventListener("abort", onParentAbort)),
      { cancel: () => controller.abort("Cancelled by user.") }
    )
    deps.dispatch({
      type: "NOTICE",
      message: `Subagent "${id}" started in background (runId: ${runId}). Watch it with /agents (ctrl+b), stop it with /agents stop ${runId}.`,
    })
    return
  }

  deps.dispatch({ type: "ACTIVITY_START", kind: "agent", label: truncate(`${id}: ${prompt}`) })
  const r = await execute(undefined, deps.signal)
  deps.dispatch({
    type: "ACTIVITY_END",
    status: r.outcome === "error" || r.outcome === "refused" ? "error" : "done",
    summary: r.summary,
  })
}

/** Owner-scoped stop used by the existing agents command/panel surface. */
export function agentsStop(
  arg: string,
  deps: {
    dispatch: (action: TuiAction) => void
    sessionId: string
    cancel?: typeof cancelCliBackgroundRun
  }
): void {
  const id = arg.trim()
  if (!id || /\s/.test(id)) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /agents stop <runId>" })
    return
  }
  const stopped = (deps.cancel ?? cancelCliBackgroundRun)(id, deps.sessionId)
  deps.dispatch({
    type: "NOTICE",
    message: stopped
      ? `Cancellation requested for background run ${id}.`
      : `No cancellable background run "${id}" in this session.`,
  })
}

/** The minimal fs surface authoring needs, injectable for tests. */
export interface AgentAuthoringFs {
  exists(p: string): Promise<boolean>
  mkdir(p: string): Promise<void>
  writeText(p: string, text: string): Promise<void>
  unlink(p: string): Promise<void>
}

const defaultAuthoringFs: AgentAuthoringFs = {
  async exists(p) {
    try {
      await nodeFs.access(p)
      return true
    } catch {
      return false
    }
  },
  async mkdir(p) {
    await nodeFs.mkdir(p, { recursive: true })
  },
  writeText: (p, text) => nodeFs.writeFile(p, text, "utf8"),
  unlink: (p) => nodeFs.unlink(p),
}

/** Agent ids are file stems: kebab or dotted, no separators or spaces. */
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i

/** Where a project (or home) root keeps its agent files. */
export function agentFilePath(root: string, id: string): string {
  return path.join(root, ".cognia", "agents", `${id}.md`)
}

/**
 * The frontmatter every optional field is documented in, commented out, so a
 * new agent file teaches its own format. Spliced in after the fields the
 * serializer wrote, before the closing fence.
 */
const OPTIONAL_FIELD_GUIDE = [
  "# Optional fields (uncomment to use):",
  "# model: sonnet             # model id or alias for this agent",
  "# provider: anthropic       # run on another configured provider (pairs with model)",
  "# tools: read, grep, glob   # allowlist (omit to inherit every tool)",
  "# disallowedTools: bash     # tools this agent may never use",
  "# effort: high              # low | medium | high | xhigh | max",
  "# maxTurns: 20              # round-trip ceiling",
  "# color: cyan               # red orange yellow green cyan blue purple pink gray",
  "# allowNesting: true        # may dispatch its own subagents (depth-capped)",
  "# hidden: true              # keep out of pickers, still dispatchable",
].join("\n")

/** Render a starter agent file for `id`. Exported so tests can pin its shape. */
export function renderStarterAgentFile(id: string, description: string): string {
  const prompt = [
    `You are ${id}, a focused subagent for this project.`,
    "",
    "Describe the job in one or two sentences: which tasks the dispatcher should hand you, and what a finished result looks like.",
    "",
    "How to work:",
    "1. Read the files the task names first, then search for what it does not name.",
    "2. Ground every claim in a real path and line number.",
    "3. Stay within the task. Report what you could not verify instead of guessing.",
    "",
    "Final report: a short structured summary (findings, files touched, remaining unknowns). The dispatcher sees only this message.",
  ].join("\n")
  const serialized = serializeMarkdownAgent(id, { description, prompt })
  const fence = serialized.indexOf("\n---\n", 4)
  if (fence === -1) return serialized
  return `${serialized.slice(0, fence)}\n${OPTIONAL_FIELD_GUIDE}${serialized.slice(fence)}`
}

export interface AgentsAuthoringDeps {
  dispatch: (action: TuiAction) => void
  /** The project root. New files land here, never in the home root. */
  cwd: string
  fs?: AgentAuthoringFs
}

/** `/agents new <id> [description]`: scaffold `.cognia/agents/<id>.md`. */
export async function agentsNew(arg: string, deps: AgentsAuthoringDeps): Promise<void> {
  const fs = deps.fs ?? defaultAuthoringFs
  const [id = "", ...rest] = arg.trim().split(/\s+/).filter(Boolean)
  if (!id) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /agents new <id> [description]" })
    return
  }
  if (!AGENT_ID_PATTERN.test(id)) {
    deps.dispatch({
      type: "NOTICE",
      message: `"${id}" is not a valid agent id. Use letters, digits, dots, dashes or underscores, for example code-reviewer.`,
    })
    return
  }
  const file = agentFilePath(deps.cwd, id)
  const rel = path.relative(deps.cwd, file)
  if (await fs.exists(file)) {
    deps.dispatch({
      type: "NOTICE",
      message: `${rel} already exists. Open it with /agents edit ${id}, or remove it with /agents rm ${id}.`,
    })
    return
  }
  const description = rest.join(" ") || `Custom subagent ${id}. Describe when to dispatch it.`
  try {
    await fs.mkdir(path.dirname(file))
    await fs.writeText(file, renderStarterAgentFile(id, description))
  } catch (error) {
    deps.dispatch({ type: "NOTICE", message: `Could not write ${rel}: ${errorMessage(error)}` })
    return
  }
  deps.dispatch({
    type: "NOTICE",
    message: `Created ${rel}. Edit its prompt with /agents edit ${id}. It is dispatchable now: /agents run ${id} <prompt>, and the model can pick it by its description.`,
  })
}

/** `/agents rm <id>`: delete the PROJECT agent file. Home-root agents stay. */
export async function agentsRemove(arg: string, deps: AgentsAuthoringDeps): Promise<void> {
  const fs = deps.fs ?? defaultAuthoringFs
  const id = arg.trim()
  if (!id || /\s/.test(id) || !AGENT_ID_PATTERN.test(id)) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /agents rm <id>" })
    return
  }
  const file = agentFilePath(deps.cwd, id)
  const rel = path.relative(deps.cwd, file)
  if (!(await fs.exists(file))) {
    deps.dispatch({
      type: "NOTICE",
      message: `No ${rel} in this project. Built-in agents and home-root agents (~/.cognia/agents) are not removed from here.`,
    })
    return
  }
  try {
    await fs.unlink(file)
  } catch (error) {
    deps.dispatch({ type: "NOTICE", message: `Could not remove ${rel}: ${errorMessage(error)}` })
    return
  }
  deps.dispatch({ type: "NOTICE", message: `Removed ${rel}.` })
}

/**
 * `/agents edit <id>`: the effect that opens the agent file in the user's
 * editor. Synchronous by design so it can be a plain command handler and reuse
 * the existing `openFile` effect (editor detection, fallback notice). Project
 * root wins over home root, matching discovery precedence. A built-in has no
 * file: the notice explains how to shadow it.
 */
export function agentsEditEffect(
  arg: string,
  deps: { cwd: string; home?: string; exists: (p: string) => boolean }
): CommandEffect {
  const id = arg.trim()
  if (!id || /\s/.test(id) || !AGENT_ID_PATTERN.test(id)) {
    return { kind: "notice", message: "Usage: /agents edit <id>" }
  }
  const roots = deps.home ? [deps.cwd, deps.home] : [deps.cwd]
  for (const root of roots) {
    const file = agentFilePath(root, id)
    if (deps.exists(file)) return { kind: "openFile", file }
  }
  return {
    kind: "notice",
    message: `No agent file for "${id}" in this project or ~/.cognia/agents. Built-in agents have no file: run /agents new ${id} to create one that replaces it.`,
  }
}
