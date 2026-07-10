/**
 * CLI subagent dispatch — surfaces the `dispatch_agent` (Task) tool to the model
 * and resolves its calls over the live sidecar.
 *
 * Why this exists: the non-Anthropic (ai-sdk) dispatch channel has no SDK-native
 * Task tool, so a model on OpenAI/DeepSeek/OpenCode/… cannot delegate to a
 * subagent the way the Anthropic channel can (via `SendOptions.agents`). We close
 * that gap by advertising the SAME provider-agnostic `dispatch_agent` plugin tool
 * the desktop uses (it rides the `plugin_tool_exec` wire the ai-sdk bridge
 * already supports), and routing its calls to {@link runCliSubagent} — which runs
 * the subagent with the CLI's own config/provider instead of the desktop's
 * Dexie-backed `executeAgent` path.
 *
 * The handler resolves the caller's per-turn context (gate, signal, MCP servers,
 * the discovered subagents) from a registry keyed by chat session id; the chat
 * session-runner publishes it for the duration of each turn.
 */

import {
  DISPATCH_AGENT_TOOL_NAME,
  TASK_TOOL_NAME,
  buildDispatchAgentManifestEntry,
  parseDispatchAgentArgs,
  type NormalizedDispatch,
} from "@/lib/claude/agents/dispatch-agent-tool"
import { runDispatchFanout } from "@/lib/claude/agents/dispatch-core"
import type { PluginToolManifestEntry } from "@/lib/plugin/bridge/sidecar-tools-bridge"
import {
  handlePluginToolExec,
  type PluginToolExecRequest,
  type PluginToolExecResponse,
} from "@/lib/claude/plugin-tool-ipc"
import type { McpServer } from "@/lib/claude/types"

import { type ResolvedConfig } from "../config/schema"
import { type AgentSummary } from "./discover-agents"
import { type PermissionResponder } from "./permission-gate"
import { runCliSubagent, type CliSubagentResult, type RunCliSubagentDeps } from "./subagent-runner"
import { LOAD_SKILL_TOOL_NAME, handleCliLoadSkill } from "./skill-load-tool"
import {
  startCliBackgroundRun,
  collectCliBackgroundResult,
  getCliBackgroundRecord,
} from "./subagent-background-tasks"
import { frameResumePrompt } from "@/lib/background-tasks/completion-delivery"
import {
  startLiveSubagent,
  applyLiveSubagentEvent,
  settleLiveSubagent,
} from "./subagent-live-output"
import { errorMessage } from "../tui/runtime/shared"

/**
 * Max concurrent CLI subagent runs in a single `dispatch_agent` fan-out. The CLI
 * has no token-budget accounting (unlike the renderer, which serializes under a
 * finite budget), so it bounds concurrency to keep a large sibling batch from
 * spawning unbounded parallel runs over the one live sidecar.
 */
const CLI_MAX_CONCURRENT_SUBAGENTS = 8

/**
 * Fallback nesting cap when neither the context nor the resolved config carry
 * one — same value as the desktop's `DEFAULT_NESTING_MAX_DEPTH` (kept local so
 * the CLI never imports the Dexie-backed desktop handler module).
 */
export const CLI_DEFAULT_SUBAGENT_MAX_DEPTH = 2

/** Per-turn context the `dispatch_agent` handler reads, keyed by session id —
 * the chat session for the main turn, or a child subagent session when the run
 * was granted nested delegation (registered by {@link handleCliDispatchAgent}
 * through the runner's nesting seam). */
export interface CliSubagentDispatchContext {
  /** Subagents the model may target (drives the tool enum AND id resolution). */
  agents: AgentSummary[]
  config: ResolvedConfig
  home: string
  cwd: string
  gate: PermissionResponder
  signal?: AbortSignal
  mcpServers: McpServer[]
  approvedTools: Set<string>
  disabledMcpTools: Set<string>
  // ── Nesting (absent on the main chat session ⇒ depth 0 / fresh chain) ──────
  /** The CALLER's depth: 0 = the chat turn, 1 = a subagent, … */
  depth?: number
  /** Nesting cap for the whole tree; defaults from `config.subagentMaxDepth`. */
  maxDepth?: number
  /** Subagent ids on the dispatch chain above the caller (cycle guard). */
  parentChain?: string[]
  /** The caller's own live-output id (the tree edge for its children). */
  selfLiveId?: string
  /** The ROOT chat session that owns the whole tree — live entries are keyed to
   * it so nested runs stay visible to the owning TUI session. */
  rootSessionId?: string
  /** Injected subagent runner (tests); defaults to {@link runCliSubagent}. */
  run?: (
    def: AgentSummary["def"],
    prompt: string,
    parentSessionId: string,
    deps: RunCliSubagentDeps
  ) => Promise<CliSubagentResult>
  /** Mint a background run id (tests); defaults to a short random token. */
  mintRunId?: () => string
}

function defaultMintRunId(): string {
  try {
    return `bg-${crypto.randomUUID().slice(0, 8)}`
  } catch {
    return `bg-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  }
}

const contexts = new Map<string, CliSubagentDispatchContext>()

/** Publish the dispatch context for a session (called at the head of each turn). */
export function registerCliSubagentContext(
  sessionId: string,
  ctx: CliSubagentDispatchContext
): void {
  contexts.set(sessionId, ctx)
}

/** Retire a session's dispatch context (called when the turn settles). */
export function clearCliSubagentContext(sessionId: string): void {
  contexts.delete(sessionId)
}

/** Read a session's dispatch context (exported for tests / introspection). */
export function getCliSubagentContext(sessionId: string): CliSubagentDispatchContext | undefined {
  return contexts.get(sessionId)
}

/**
 * Build the `dispatch_agent` (Task) manifest entry advertising `agents` to the
 * model. Returns `null` when there are no dispatchable subagents, so the caller
 * advertises nothing rather than an empty tool.
 */
export function buildCliSubagentToolManifest(
  agents: AgentSummary[]
): PluginToolManifestEntry | null {
  if (agents.length === 0) return null
  return buildDispatchAgentManifestEntry(
    agents.map((a) => ({ id: a.id, description: a.description }))
  )
}

/** Compact `( … )` run-summary suffix: token spend + a non-success finish reason. */
function metaSuffix(r: CliSubagentResult): string {
  const meta: string[] = []
  const total = (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0)
  if (total > 0) meta.push(`${total} tok`)
  if (r.finishReason && r.finishReason !== "success") meta.push(r.finishReason)
  return meta.length > 0 ? `  (${meta.join(" · ")})` : ""
}

/**
 * Resolve a `dispatch_agent` / `Task` `plugin_tool_exec` request: run the named
 * subagent(s) over the live sidecar and return their output as the tool result.
 * Never throws — every failure mode collapses onto a readable `result` (or
 * `error`) string so the model's tool call always settles.
 */
export async function handleCliDispatchAgent(
  req: PluginToolExecRequest
): Promise<PluginToolExecResponse> {
  const base = {
    type: "plugin_tool_response" as const,
    sessionId: req.sessionId,
    toolUseId: req.toolUseId,
  }
  const ctx = getCliSubagentContext(req.sessionId)
  if (!ctx) {
    return { ...base, error: "dispatch_agent: no active subagent context for this session." }
  }
  const parsed = parseDispatchAgentArgs(req.args)
  if (parsed.mode === "error") return { ...base, result: parsed.message }
  if (parsed.mode === "collect") {
    // Scope the collect to the OWNING chat session so a run started by a
    // different chat session (or one cleared away with `/clear`) reads as
    // unknown rather than leaking another session's subagent output back to
    // this model. Background runs are owned by the root chat session even when
    // a nested subagent started them, so any member of the tree may collect.
    const collected = await collectCliBackgroundResult(parsed.runId, {
      home: ctx.home,
      owner: ctx.rootSessionId ?? req.sessionId,
    })
    if (collected === undefined) {
      return {
        ...base,
        result: `dispatch_agent: no background run "${parsed.runId}".`,
      }
    }
    return { ...base, result: collected }
  }

  const run = ctx.run ?? runCliSubagent
  const mintRunId = ctx.mintRunId ?? defaultMintRunId

  // ── Nesting state for THIS caller ───────────────────────────────────────────
  // The main chat session registers no nesting fields (depth 0, fresh chain);
  // a child session's context was registered by its dispatching `executeOne`.
  const depth = ctx.depth ?? 0
  const maxDepth = ctx.maxDepth ?? ctx.config.subagentMaxDepth ?? CLI_DEFAULT_SUBAGENT_MAX_DEPTH
  const parentChain = ctx.parentChain ?? []
  const rootSessionId = ctx.rootSessionId ?? req.sessionId
  const childDepth = depth + 1

  /** Refuse a dispatch the nesting policy forbids (cycle / depth cap), mirroring
   * the desktop's `dispatchSubagent` guards. `null` ⇒ the dispatch may run.
   * Depth is belt-and-braces: at the cap the tool isn't even advertised. */
  const refuseByPolicy = (d: NormalizedDispatch, label: string): DispatchOutcome | null => {
    if (parentChain.includes(d.subagentId)) {
      const chain = [...parentChain, d.subagentId].join(" → ")
      return {
        text: `[${label}] Dispatch refused — "${d.subagentId}" is already on the dispatch chain (${chain}). Cycles are not allowed.`,
        ok: false,
      }
    }
    if (childDepth > maxDepth) {
      return {
        text: `[${label}] Dispatch refused — max nesting depth (${maxDepth}) reached.`,
        ok: false,
      }
    }
    return null
  }

  /** One dispatch's outcome: the line shown to the model + whether it FAILED.
   * `ok: false` is reserved for genuine faults (the run threw, or an unknown
   * subagent id) — NOT for a neutral interrupt or a non-success finish reason —
   * so the dispatching tool call can render red ✗ rather than a green ✓ when a
   * subagent actually failed. */
  type DispatchOutcome = { text: string; ok: boolean }

  /** The body of one dispatch — never throws (errors collapse onto a line).
   * `liveId` ties the run to its TUI live-output entry: background runs pass their
   * `runId` (so the `/agents` panel shows one row, not two); foreground runs leave
   * it undefined and a fresh `live-…` id is minted. */
  const executeOne = async (
    d: NormalizedDispatch,
    label: string,
    liveId?: string
  ): Promise<DispatchOutcome> => {
    const refused = refuseByPolicy(d, label)
    if (refused) return refused
    const match = ctx.agents.find((a) => a.id === d.subagentId)
    if (!match) {
      const known = ctx.agents.map((a) => a.id).join(", ") || "(none)"
      return {
        text: `[${label}] Unknown subagent "${d.subagentId}". Available: ${known}.`,
        ok: false,
      }
    }
    // Register the live-output entry so the TUI run-page can stream this run.
    // Keyed to the ROOT chat session (not the ephemeral parent subagent
    // session), so a nested run stays visible to the owning TUI session.
    const live = startLiveSubagent({
      ...(liveId ? { liveId } : {}),
      name: d.subagentId,
      task: d.prompt,
      sessionId: rootSessionId,
      depth: childDepth,
      ...(ctx.selfLiveId ? { parentLiveId: ctx.selfLiveId } : {}),
    })
    // Grant the child nested delegation only while it would run BELOW the cap:
    // at the cap the tool is simply not advertised (the child is a leaf), the
    // depth-N generalization of Claude Code dropping the Agent tool from
    // subagents. The child's dispatch context inherits this caller's resolved
    // turn state and extends the chain for the cycle guard.
    const nesting =
      childDepth < maxDepth
        ? {
            manifest: buildCliSubagentToolManifest(ctx.agents),
            register: (childSessionId: string) =>
              registerCliSubagentContext(childSessionId, {
                ...ctx,
                depth: childDepth,
                maxDepth,
                parentChain: [...parentChain, d.subagentId],
                selfLiveId: live,
                rootSessionId,
              }),
            unregister: clearCliSubagentContext,
          }
        : undefined
    try {
      const r = await run(match.def, d.prompt, req.sessionId, {
        config: ctx.config,
        home: ctx.home,
        cwd: ctx.cwd,
        gate: ctx.gate,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        mcpServers: ctx.mcpServers,
        approvedTools: ctx.approvedTools,
        disabledMcpTools: ctx.disabledMcpTools,
        onEvent: (event) => applyLiveSubagentEvent(live, event),
        ...(nesting ? { nesting } : {}),
      })
      settleLiveSubagent(live, "done")
      return { text: `[${label}]${metaSuffix(r)}\n${r.text}`, ok: true }
    } catch (err) {
      // A parent interrupt aborts the shared signal mid-run: report it as an
      // interruption (not a fault) so the model gets an accurate signal instead
      // of a raw abort-error string. An interrupt is neutral (`ok: true`) — it's
      // a user action, not a subagent failure.
      if (ctx.signal?.aborted) {
        settleLiveSubagent(live, "interrupted")
        return { text: `[${label}] interrupted.`, ok: true }
      }
      settleLiveSubagent(live, "error")
      return { text: `[${label}] failed: ${errorMessage(err)}`, ok: false }
    }
  }

  const runOne = async (d: NormalizedDispatch, label: string): Promise<DispatchOutcome> => {
    if (!d.background) return executeOne(d, label)
    // Background: surface a policy refusal or an unknown id synchronously
    // (cheap, avoids a useless parked run), otherwise start the run, park it,
    // and return its runId now.
    const refused = refuseByPolicy(d, label)
    if (refused) return refused
    const match = ctx.agents.find((a) => a.id === d.subagentId)
    if (!match) {
      const known = ctx.agents.map((a) => a.id).join(", ") || "(none)"
      return {
        text: `[${label}] Unknown subagent "${d.subagentId}". Available: ${known}.`,
        ok: false,
      }
    }
    const runId = mintRunId()
    startCliBackgroundRun(
      runId,
      {
        kind: "subagent",
        subagentId: d.subagentId,
        prompt: d.prompt,
        // Owned by the ROOT chat session (nested dispatchers park runs the
        // whole tree — and the user's panel — can see and collect).
        sessionId: rootSessionId,
        host: "cli",
        startedAt: Date.now(),
        mode: "background",
        toolsEnabled: d.toolsEnabled,
        home: ctx.home,
      },
      // Share the background `runId` as the live-output id so the panel never
      // shows the run twice (once live, once from the journal record).
      executeOne(d, d.subagentId, runId).then((o) => o.text)
    )
    return {
      text: `[${d.subagentId}] started in background (runId: ${runId}). Collect later with dispatch_agent({collect:"${runId}"}).`,
      ok: true,
    }
  }

  if (parsed.mode === "resume") {
    // Continue a FINISHED run: re-frame its prompt + outcome as context and
    // re-dispatch the same subagent (owner-scoped like collect).
    const record = await getCliBackgroundRecord(parsed.runId, {
      home: ctx.home,
      owner: rootSessionId,
    })
    if (!record) {
      return { ...base, result: `dispatch_agent: no background run "${parsed.runId}".` }
    }
    if (record.status === "running") {
      return {
        ...base,
        result: `dispatch_agent: run "${parsed.runId}" is still running — collect it or wait for it to finish.`,
      }
    }
    const framed = frameResumePrompt(
      {
        prompt: record.prompt,
        outcome: record.resultText ?? record.error ?? "(no output recorded)",
      },
      parsed.prompt
    )
    const resumeDispatch: NormalizedDispatch = {
      subagentId: record.subagentId,
      prompt: framed,
      toolsEnabled: parsed.toolsEnabled ?? record.toolsEnabled ?? true,
      background: parsed.background,
    }
    const outcome = await runOne(resumeDispatch, `${record.subagentId} (resumed)`)
    return outcome.ok ? { ...base, result: outcome.text } : { ...base, error: outcome.text }
  }

  // Fan-out via the shared core (unified with the renderer handler). The CLI has
  // no token-budget accounting, so it bounds CONCURRENCY instead of serializing
  // under a budget: a large sibling batch no longer spawns unbounded concurrent
  // subagent runs over the one live sidecar (the old `Promise.all` had no cap).
  const outcomes = await runDispatchFanout({
    dispatches: parsed.dispatches,
    width: CLI_MAX_CONCURRENT_SUBAGENTS,
    runOne: (d, label) => runOne(d, label),
  })
  const result = outcomes.map((o) => o.text).join("\n\n---\n\n")
  // Surface the dispatch as a tool ERROR (red ✗, and a recoverable tool-error
  // the model can react to) when EVERY dispatch failed — the common single
  // dispatch that errored, or a fan-out where nothing succeeded. A mixed
  // outcome stays a `result` so the partial successes still read normally.
  const allFailed = outcomes.length > 0 && outcomes.every((o) => !o.ok)
  return allFailed ? { ...base, error: result } : { ...base, result }
}

/**
 * Wrap the default `plugin_tool_exec` handler so `dispatch_agent` / `Task` calls
 * resolve through {@link handleCliDispatchAgent} (CLI-native subagent run) and
 * `load_skill` calls resolve through {@link handleCliLoadSkill} (read the skill
 * body from the CLI-local Dexie for name-only progressive disclosure), while
 * every other plugin/web/skill tool still flows through `handlePluginToolExec`.
 */
export function makeCliPluginToolHandle(
  fallback: (req: PluginToolExecRequest) => Promise<PluginToolExecResponse> = handlePluginToolExec
): (req: PluginToolExecRequest) => Promise<PluginToolExecResponse> {
  return (req) => {
    if (req.name === DISPATCH_AGENT_TOOL_NAME || req.name === TASK_TOOL_NAME) {
      return handleCliDispatchAgent(req)
    }
    if (req.name === LOAD_SKILL_TOOL_NAME) return handleCliLoadSkill(req)
    return fallback(req)
  }
}
