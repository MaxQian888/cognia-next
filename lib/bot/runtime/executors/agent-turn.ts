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

import { BotExecutorUnavailableError, type BotExecutorContext, type BotExecutorFn } from "./types"

export interface AgentTurnExecutorDeps {
  run?: (input: {
    characterId: string
    prompt: string
    cwd: string
    signal?: AbortSignal
    timeoutMs?: number
    permissionMode?: SendOptions["permissionMode"]
  }) => Promise<{ sessionId: string; text: string }>
}

/** The prompt a turn is given, with placeholders resolved from the envelope. */
export function agentTurnPrompt(ctx: BotExecutorContext): string {
  return interpolateEnvelopeTemplate(ctx.definition.prompt ?? "", ctx.event)
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
      (async (input) => {
        const { runPluginAgentTurn } = await import("@/lib/plugin/api/agent-turn")
        return runPluginAgentTurn(input)
      })

    const result = await run({
      characterId,
      prompt: agentTurnPrompt(ctx),
      cwd: ctx.cwd,
      signal: ctx.signal,
      ...(ctx.policy.maxRunDurationMs ? { timeoutMs: ctx.policy.maxRunDurationMs } : {}),
      // The resolved ceiling, never a widened default. `bypassPermissions` is
      // reachable only when every layer already allowed it.
      ...(ctx.composition.selection.authority
        ? { permissionMode: ctx.composition.selection.authority }
        : {}),
    })

    return { summary: result.text.slice(0, 200), output: { sessionId: result.sessionId } }
  }
}

export const runAgentTurnBot = createAgentTurnBotExecutor()
