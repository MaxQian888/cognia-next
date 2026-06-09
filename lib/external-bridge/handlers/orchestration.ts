/**
 * External Bridge handlers — orchestration tools (Thread D).
 *
 * Let an external coding agent drive Cognia's OWN agent runtime:
 *  - `agent_dispatch` — run a built-in / plugin subagent (`subagentId`) or a
 *    character (`characterId`, full `resolveSendOptions` pipeline) headlessly.
 *  - `team_run` — start an Agent Team headlessly.
 *  - `plugin_tool_invoke` — invoke a plugin-registered tool (the plugin's own
 *    consent gate + ownership check still apply per call).
 *
 * # Wire path (staged)
 *
 * The orchestration entry points (`executeAgent`, `agentTeamManager`,
 * `getPluginManager`) live in the RENDERER, not the Node MCP sidecar. The
 * existing automation proxy reaches Rust only, not renderer JS, so a dedicated
 * sidecar→Rust→renderer orchestration proxy is a flagged follow-up (Thread D4).
 *
 * Until then: when invoked from the renderer (or a test mount) — `isTauri()`
 * true — the handler runs the real entry points directly. From the production
 * Node sidecar it returns a structured "requires desktop runtime" error (the
 * `computer_use` standalone-mode precedent) so the external agent sees a clear
 * reason instead of a silent failure.
 *
 * PII: `agent_dispatch` / `team_run` can surface twin / shared-memory context
 * outward, so the returned text is run through the redaction gate
 * (`lib/twin/ingest/redact.ts`) before it leaves the trust boundary.
 */

import { isTauri } from "@/lib/tauri"

const SIDECAR_FALLBACK =
  "Orchestration tools require the Cognia desktop renderer — the sidecar→renderer " +
  "orchestration proxy is not yet wired (Thread D4 follow-up)."

// ---------------------------------------------------------------------------
// agent_dispatch
// ---------------------------------------------------------------------------

export interface AgentDispatchInput {
  /** Run a registered subagent by id. */
  subagentId?: string
  /** Or run a character through the full resolveSendOptions pipeline. */
  characterId?: string
  /** The prompt for the dispatched run. */
  prompt: string
  /** Tool-enabled sidecar loop (default true). */
  toolsEnabled?: boolean
  /** Working directory for the run. */
  cwd?: string
}

export interface AgentDispatchOutput {
  ok: boolean
  text?: string
  channel?: string
  finishReason?: string
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  /** True iff the returned text was PII-redacted on the way out. */
  redacted?: boolean
  error?: string
}

export async function agentDispatch(input: AgentDispatchInput): Promise<AgentDispatchOutput> {
  if (!isTauri()) return { ok: false, error: SIDECAR_FALLBACK }
  if (!input.prompt || !input.prompt.trim()) {
    return { ok: false, error: "agent_dispatch requires a non-empty prompt" }
  }
  if (!input.subagentId && !input.characterId) {
    return { ok: false, error: "agent_dispatch requires either subagentId or characterId" }
  }

  try {
    const { redactText } = await import("@/lib/twin/ingest/redact")

    let text: string
    let channel: string | undefined
    let finishReason: string | undefined
    let usage: AgentDispatchOutput["usage"]

    if (input.subagentId) {
      const { dispatchSubagent } = await import("@/lib/plugin/agent-sdk/dispatch")
      const result = await dispatchSubagent(input.subagentId, input.prompt, {
        toolsEnabled: input.toolsEnabled ?? true,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      })
      text = result.text
      channel = result.channel
      finishReason = result.finishReason
      usage = result.usage
    } else {
      const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
      const result = await executeAgent(input.prompt, {
        characterId: input.characterId,
        toolsEnabled: input.toolsEnabled ?? true,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      })
      text = result.text
      channel = result.channel
      finishReason = result.finishReason
      usage = result.usage
        ? {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
          }
        : undefined
    }

    // Outward PII gate: substitute placeholders for any leaked PII before the
    // text crosses to the external CLI.
    const { redacted, map } = redactText(text ?? "")
    const wasRedacted = Object.keys(map).length > 0

    return {
      ok: true,
      text: redacted,
      ...(channel ? { channel } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(usage ? { usage } : {}),
      ...(wasRedacted ? { redacted: true } : {}),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// team_run
// ---------------------------------------------------------------------------

export interface TeamRunInput {
  teamId: string
  ultracode?: boolean
}

export interface TeamRunOutput {
  ok: boolean
  teamId?: string
  status?: string
  error?: string
}

export async function teamRun(input: TeamRunInput): Promise<TeamRunOutput> {
  if (!isTauri()) return { ok: false, error: SIDECAR_FALLBACK }
  if (!input.teamId) return { ok: false, error: "team_run requires a teamId" }

  try {
    const { runTeam } = await import("@/lib/plugin/agent-sdk/dispatch")
    const result = await runTeam(input.teamId, {
      ...(input.ultracode !== undefined ? { ultracode: input.ultracode } : {}),
    })
    return { ok: true, teamId: result.teamId, status: result.status }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// plugin_tool_invoke
// ---------------------------------------------------------------------------

export interface PluginToolInvokeInput {
  pluginId: string
  toolName: string
  args?: Record<string, unknown>
  /** Optional human-readable reason recorded with the consent prompt. */
  reason?: string
}

export interface PluginToolInvokeOutput {
  ok: boolean
  result?: unknown
  error?: string
  /** Typed PluginToolInvocationError code when ok === false. */
  code?: string
}

export async function pluginToolInvoke(
  input: PluginToolInvokeInput
): Promise<PluginToolInvokeOutput> {
  if (!isTauri()) return { ok: false, error: SIDECAR_FALLBACK }
  if (!input.pluginId || !input.toolName) {
    return { ok: false, error: "plugin_tool_invoke requires pluginId and toolName" }
  }

  try {
    const { invokePluginTool } = await import("@/lib/plugin/core/invoke-plugin-tool")
    const result = await invokePluginTool(input.pluginId, input.toolName, input.args ?? {}, {
      ...(input.reason ? { reason: input.reason } : {}),
    })
    return { ok: true, result }
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(code ? { code } : {}),
    }
  }
}
