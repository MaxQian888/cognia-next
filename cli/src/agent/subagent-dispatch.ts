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
import { startCliBackgroundRun, collectCliBackgroundResult } from "./subagent-background-registry"
import { errorMessage } from "../tui/runtime/shared"

/** Per-turn context the `dispatch_agent` handler reads, keyed by chat session id. */
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
    const collected = await collectCliBackgroundResult(parsed.runId)
    if (collected === undefined) {
      return {
        ...base,
        result: `dispatch_agent: no background run "${parsed.runId}" (already collected or unknown).`,
      }
    }
    return { ...base, result: collected }
  }

  const run = ctx.run ?? runCliSubagent
  const mintRunId = ctx.mintRunId ?? defaultMintRunId

  /** The synchronous body of one dispatch — never throws (errors collapse onto a line). */
  const executeOne = async (d: NormalizedDispatch, label: string): Promise<string> => {
    const match = ctx.agents.find((a) => a.id === d.subagentId)
    if (!match) {
      const known = ctx.agents.map((a) => a.id).join(", ") || "(none)"
      return `[${label}] Unknown subagent "${d.subagentId}". Available: ${known}.`
    }
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
      })
      return `[${label}]${metaSuffix(r)}\n${r.text}`
    } catch (err) {
      return `[${label}] failed: ${errorMessage(err)}`
    }
  }

  const runOne = async (d: NormalizedDispatch, label: string): Promise<string> => {
    if (!d.background) return executeOne(d, label)
    // Background: surface an unknown id synchronously (cheap, avoids a useless
    // parked run), otherwise start the run, park it, and return its runId now.
    const match = ctx.agents.find((a) => a.id === d.subagentId)
    if (!match) {
      const known = ctx.agents.map((a) => a.id).join(", ") || "(none)"
      return `[${label}] Unknown subagent "${d.subagentId}". Available: ${known}.`
    }
    const runId = mintRunId()
    startCliBackgroundRun(runId, d.subagentId, executeOne(d, d.subagentId))
    return `[${d.subagentId}] started in background (runId: ${runId}). Collect later with dispatch_agent({collect:"${runId}"}).`
  }

  let result: string
  if (parsed.dispatches.length === 1) {
    const d = parsed.dispatches[0]
    result = await runOne(d, d.subagentId)
  } else {
    // Parallel fan-out: all siblings run concurrently over the live sidecar.
    const settled = await Promise.all(
      parsed.dispatches.map((d, i) => runOne(d, `${d.subagentId}#${i + 1}`))
    )
    result = settled.join("\n\n---\n\n")
  }
  return { ...base, result }
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
