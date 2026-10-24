/**
 * Run one bounded agent turn.
 *
 * The prompt is a TEMPLATE the definition's author wrote, interpolated against
 * the envelope. The event's payload is never concatenated in raw: it is
 * whoever opened the pull request or sent the message, and a prompt that
 * splices it in is a prompt a stranger co-authored. Placeholders resolve to
 * scalar fields only, and everything else the turn needs it reads through
 * tools, where the ordinary permission gates apply.
 */

import { interpolateEnvelopeTemplate } from "@/lib/bot/events/envelope"
import type { SendOptions } from "@cognia/agent-config-types"
import type { AgentCompositionSelectionV1 } from "@cognia/agent-config-types/agent-composition"
import type {
  PluginAgentTurnRequest,
  PluginAgentTurnResult,
} from "@cognia/plugin-sdk/api/agent-turn"
import type { PluginAgentTurnUsageBooking } from "@/lib/plugin/api/agent-turn"

import { BotExecutorUnavailableError, type BotExecutorContext, type BotExecutorFn } from "./types"

export interface AgentTurnExecutorDeps {
  run?: (input: {
    characterId: string
    prompt: string
    cwd: string
    signal?: AbortSignal
    timeoutMs?: number
    permissionMode?: SendOptions["permissionMode"]
    composition?: AgentCompositionSelectionV1
    capabilityGrants?: PluginAgentTurnRequest["capabilityGrants"]
    usage: PluginAgentTurnUsageBooking
  }) => Promise<
    Pick<PluginAgentTurnResult, "sessionId" | "text"> &
      Partial<Pick<PluginAgentTurnResult, "status" | "needsApproval">>
  >
}

/**
 * The prompt a turn is given, with placeholders resolved from the envelope
 * and `{{config.*}}` placeholders from the resolved installation config.
 */
export function agentTurnPrompt(ctx: BotExecutorContext): string {
  return interpolateEnvelopeTemplate(ctx.definition.prompt ?? "", ctx.event, {
    config: ctx.config,
  })
}

/**
 * Where the turn's spend lands in the usage ledger: one row per run, grouped
 * under `bot:<runId>`. The turn is memoized as the run's `agent-turn` step, so
 * the id is stable across a crash-replayed handler and a re-booking overwrites.
 */
export function agentTurnUsageBooking(ctx: BotExecutorContext): PluginAgentTurnUsageBooking {
  return {
    operationId: `bot:${ctx.runId}:agent-turn`,
    sessionId: `bot:${ctx.runId}`,
    runId: ctx.runId,
    ...(ctx.installation.projectId ? { projectId: ctx.installation.projectId } : {}),
  }
}

export function createAgentTurnBotExecutor(deps: AgentTurnExecutorDeps = {}): BotExecutorFn {
  return async (ctx) => {
    if (!ctx.definition.prompt?.trim()) {
      throw new BotExecutorUnavailableError(
        "agent-turn",
        `Bot "${ctx.definition.id}" declares executor "agent-turn" without a prompt`
      )
    }
    const characterId = ctx.definition.character
    if (!characterId) {
      throw new BotExecutorUnavailableError(
        "agent-turn",
        `Bot "${ctx.definition.id}" needs a character to speak as`
      )
    }
    if (!ctx.cwd) {
      // An honest refusal rather than a guess. An account-scoped Bot with no
      // workspace has no directory to run in, and picking one for it is how a
      // turn ends up writing into the wrong checkout.
      throw new BotExecutorUnavailableError(
        "agent-turn",
        `Bot "${ctx.definition.id}" has no working directory. Scope its installation to a workspace or project.`
      )
    }

    const run =
      deps.run ??
      (async ({ usage, ...input }) => {
        const [{ runPluginAgentTurn }, { botPlanOrigin }] = await Promise.all([
          import("@/lib/plugin/api/agent-turn"),
          import("@/lib/policy/action-review/plan-context"),
        ])
        return runPluginAgentTurn(input, {
          grantSource: { kind: "bot", id: ctx.definition.id },
          sessionKey: ctx.installationId,
          unattendedLabel: `Bot: ${ctx.definition.name}`,
          usage,
          // ADR-0239: a Bot's outbound calls are planned in its installation's
          // origin; it has no origin thread, only its recipient list.
          outboundOrigin: botPlanOrigin(ctx.installation),
        })
      })

    // Inside a step, because a Bot handler is re-entered from the top after a
    // crash or a resumed wait. An unmemoized turn would be re-sent on every
    // re-entry, which for a Bot that answers a pull request means answering it
    // again, and the model call is the most expensive thing here to repeat.
    const result = await ctx.step.run("agent-turn", () =>
      run({
        characterId,
        prompt: agentTurnPrompt(ctx),
        cwd: ctx.cwd as string,
        signal: ctx.signal,
        ...(ctx.policy.maxRunDurationMs ? { timeoutMs: ctx.policy.maxRunDurationMs } : {}),
        // The resolved ceiling, never a widened default. `bypassPermissions` is
        // reachable only when every layer already allowed it.
        ...(ctx.composition.selection.authority
          ? { permissionMode: ctx.composition.selection.authority }
          : {}),
        // The whole projected composition, not just its authority: the preset's
        // prompt delta and tool set belong to this Bot, and without it the turn
        // composed from the desktop composer's last choice.
        composition: ctx.composition.selection,
        // The installation's resolved permission profile (ADR-0224 A7): what
        // this unattended turn may do without a person. Absent layers leave
        // the host's ceiling, which the turn applies on its own.
        capabilityGrants: [
          {
            schemaVersion: 1,
            source: { kind: "bot", id: ctx.definition.id },
            permissionProfile: ctx.policy.permissionProfile ?? {},
          },
        ],
        // Booked under this run whichever host runs it (ADR-0165 ledger).
        usage: agentTurnUsageBooking(ctx),
      })
    )

    // A denied tool is not a completed job. Say so in the run list and keep
    // the denials on the output so a later step (or a human) can act on them.
    // The runtime settles this status `failed` and never replays it (run.ts).
    if (result.status === "needs_approval") {
      const tools = [...new Set((result.needsApproval ?? []).map((denial) => denial.toolName))]
      return {
        summary: `needs approval: ${tools.join(", ")}`,
        output: {
          sessionId: result.sessionId,
          status: result.status,
          needsApproval: result.needsApproval ?? [],
          text: result.text,
        },
      }
    }
    return {
      summary: result.text.slice(0, 200),
      output: { sessionId: result.sessionId, status: result.status ?? "completed" },
    }
  }
}

export const runAgentTurnBot = createAgentTurnBotExecutor()
