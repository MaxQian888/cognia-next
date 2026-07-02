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
 * # Wire path
 *
 * The orchestration entry points (`executeAgent`, `agentTeamManager`,
 * `getPluginManager`) live in the RENDERER, not the Node MCP sidecar.
 *  - When invoked from the renderer (or a test mount) — `isTauri()` true — the
 *    handler runs the real entry point directly via the `*Core` functions.
 *  - From the production Node sidecar — `isTauri()` false — it forwards the call
 *    over the `orchestration_proxy` socket (Thread D4): sidecar → Rust → renderer
 *    dispatch provider → `*Core` → back. `proxyToRenderer` returns the same
 *    output shape. When the proxy env is absent (web/mobile, standalone npm
 *    plugin) it returns a structured desktop-required error.
 *
 * The `*Core` functions are the single source of truth for validation +
 * execution: both the renderer-direct path and the renderer dispatch provider
 * (running the sidecar's proxied request) call them, so PII redaction fires on
 * BOTH paths and the redacted text is what crosses back over the socket.
 *
 * PII: `agent_dispatch` / `team_run` can surface twin / shared-memory context
 * outward, so the returned text is run through the redaction gate
 * (`lib/twin/ingest/redact.ts`) inside `*Core` before it leaves the boundary.
 */

import { isTauri } from "@/lib/tauri"
import { proxyToRenderer } from "@/lib/external-bridge/orchestration-proxy-client"

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
  if (isTauri()) return agentDispatchCore(input)
  return proxyToRenderer<AgentDispatchOutput>("agent_dispatch", { ...input })
}

/**
 * Renderer-side `agent_dispatch` execution (validation + run + PII gate). Called
 * directly on the renderer path AND by the dispatch provider for the sidecar's
 * proxied request — so redaction fires on both paths.
 */
export async function agentDispatchCore(input: AgentDispatchInput): Promise<AgentDispatchOutput> {
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
  if (isTauri()) return teamRunCore(input)
  return proxyToRenderer<TeamRunOutput>("team_run", { ...input })
}

/** Renderer-side `team_run` execution. See {@link agentDispatchCore}. */
export async function teamRunCore(input: TeamRunInput): Promise<TeamRunOutput> {
  if (!input.teamId) return { ok: false, error: "team_run requires a teamId" }

  try {
    // External-handoff pickup: stamp the claim idempotently BEFORE dispatch so
    // `team_list` stops advertising the team. A second run never overwrites
    // an existing claim.
    const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
    const store = useAgentTeamStore.getState()
    const team = store.teams[input.teamId]
    if (team?.externalPickup && !team.externalPickup.claimedAt) {
      store.updateTeam(input.teamId, {
        externalPickup: {
          ...team.externalPickup,
          claimedBy: "external-bridge",
          claimedAt: new Date(),
        },
      })
    }

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
// team_list
// ---------------------------------------------------------------------------

export interface TeamListInput {
  /** Only teams marked for external pickup that no agent has claimed yet. */
  awaitingExternalOnly?: boolean
}

export interface TeamListOutput {
  ok: boolean
  teams?: Array<{
    id: string
    name: string
    status: string
    /** PII-redacted objective (the team's `task`). */
    objective: string
    awaitingExternalPickup: boolean
    requestedAt?: string
    claimedBy?: string
  }>
  error?: string
}

export async function teamList(input: TeamListInput = {}): Promise<TeamListOutput> {
  if (isTauri()) return teamListCore(input)
  return proxyToRenderer<TeamListOutput>("team_list", { ...input })
}

/**
 * Renderer-side `team_list` execution. Reads the AGENT-TEAM store (the
 * runnable entity `team_run` accepts) — NOT the Dexie `teams` table, which
 * holds character chat-teams. Name + objective are PII-redacted before they
 * cross the boundary, mirroring {@link agentDispatchCore}'s outward gate.
 */
export async function teamListCore(input: TeamListInput = {}): Promise<TeamListOutput> {
  try {
    const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
    const { redactText } = await import("@/lib/twin/ingest/redact")
    const teams = Object.values(useAgentTeamStore.getState().teams)
    const rows = teams
      .filter(
        (team) =>
          !input.awaitingExternalOnly ||
          Boolean(team.externalPickup && !team.externalPickup.claimedAt)
      )
      .map((team) => {
        // Persist layer round-trips Dates as ISO strings — tolerate both.
        const requestedAt = team.externalPickup?.requestedAt
        return {
          id: team.id,
          name: redactText(team.name ?? "").redacted,
          status: team.status,
          objective: redactText(team.task ?? "").redacted,
          awaitingExternalPickup: Boolean(team.externalPickup && !team.externalPickup.claimedAt),
          ...(requestedAt ? { requestedAt: new Date(requestedAt).toISOString() } : {}),
          ...(team.externalPickup?.claimedBy ? { claimedBy: team.externalPickup.claimedBy } : {}),
        }
      })
    return { ok: true, teams: rows }
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
  if (isTauri()) return pluginToolInvokeCore(input)
  return proxyToRenderer<PluginToolInvokeOutput>("plugin_tool_invoke", { ...input })
}

/** Renderer-side `plugin_tool_invoke` execution. See {@link agentDispatchCore}. */
export async function pluginToolInvokeCore(
  input: PluginToolInvokeInput
): Promise<PluginToolInvokeOutput> {
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

// ---------------------------------------------------------------------------
// Renderer dispatch entry — runs the `*Core` for a sidecar-proxied request.
// ---------------------------------------------------------------------------

/**
 * Execute one orchestration command on the renderer for the sidecar's proxied
 * request (Thread D4). The dispatch provider calls this with the `command` +
 * `args` carried in the `orchestration-proxy:exec` event and posts the returned
 * output back to Rust. Unknown commands return a structured error rather than
 * throwing so the round-trip always resolves.
 */
export async function runOrchestrationExec(
  command: string,
  args: Record<string, unknown>
): Promise<AgentDispatchOutput | TeamRunOutput | TeamListOutput | PluginToolInvokeOutput> {
  switch (command) {
    case "agent_dispatch":
      return agentDispatchCore(args as unknown as AgentDispatchInput)
    case "team_run":
      return teamRunCore(args as unknown as TeamRunInput)
    case "team_list":
      return teamListCore(args as unknown as TeamListInput)
    case "plugin_tool_invoke":
      return pluginToolInvokeCore(args as unknown as PluginToolInvokeInput)
    default:
      return { ok: false, error: `unknown orchestration command: ${command}` }
  }
}
