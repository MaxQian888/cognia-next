/**
 * A Squad member's turn, run as Router + Fusion work (ADR-0188 B5, D21).
 *
 * A teammate normally answers with one model turn — through the sidecar, the
 * AI-SDK fallback or an external CLI agent. A member configured with a fusion
 * action answers with a fusion run instead: `cascade` escalates from a cheap
 * model only when the cheap answer fails its check, `panel` runs a review
 * board, `direct` is one routed and ledgered call. `auto` — the default for
 * every teammate — changes nothing at all.
 *
 * D21, the two things that make a member run a CHILD rather than a rival:
 *
 *  - **The team run keeps the session lock.** A member's fusion run is created
 *    session-less (`agents/agent-fusion-run.ts` passes `sessionId: null`), so
 *    it never takes the lock on the conversation the team already holds and
 *    never writes into its transcript. The member's reply travels back through
 *    `dispatchTeammate`, which decides what the team does with it.
 *  - **The member draws on the team's pool.** `dispatchTeammate` has already
 *    opened this dispatch's child account (`RunBudgetGovernor.allocate`); this
 *    turn returns its token usage in the same shape every other channel does,
 *    so the one accounting authority books it against that child — the run's
 *    step reservation at team level — instead of a second root budget.
 *
 * Returns `null` when the member asked for nothing (or the `agentsWorkflows`
 * surface is off), and the caller runs the channel it always ran.
 */

import type { AgentTeammate } from "@/types/agent/agent-team"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import {
  fusionActionRequested,
  runExplicitAgentFusionTurn,
  type ExplicitFusionTurnInput,
} from "@/lib/router-fusion/gate/explicit-run"
import { RouterFusionRefusalError } from "@/lib/router-fusion/gate/faults"

import type { TokenUsage } from "./dispatch-teammate"

export interface MemberFusionTurnInput {
  /** The team run this member belongs to; its id scopes INV-09. */
  runId: string
  teammate: AgentTeammate
  taskId: string
  prompt: string
  systemPrompt: string
  /** The project the team works in, when it has one. */
  projectId?: string | null
  /** The directory the dispatch runs in; a panel may read files there. */
  workingDir?: string | null
  signal?: AbortSignal
  /** The activity panel's stream; a fusion answer arrives in one piece. */
  onCapture?: (event: CaptureStreamEvent) => void
  /** The account settings the gate reads; read from this host when omitted. */
  settings?: ExplicitFusionTurnInput["settings"]
  /** Test seam. */
  loadHost?: ExplicitFusionTurnInput["loadHost"]
}

export type MemberFusionTurn = { text: string; usage?: TokenUsage }

/**
 * Run the member's turn as a fusion run, or answer `null` so the caller runs
 * the ordinary channel. A refusal is thrown with the router's own code: the
 * member was configured to work this way, so a turn that silently became an
 * ordinary one would be the wrong answer, not a lenient one (D38).
 */
export async function runMemberFusionTurn(
  input: MemberFusionTurnInput
): Promise<MemberFusionTurn | null> {
  const action = input.teammate.config?.fusionAction
  if (!fusionActionRequested(action)) return null
  const settings =
    input.settings ??
    (await (
      await import("@/lib/router-fusion/gate/current-settings")
    ).currentRouterFusionGateSettings())
  const outcome = await runExplicitAgentFusionTurn({
    mode: action,
    origin: "agent",
    featureId: `teammate:${input.teammate.id}`,
    messages: [
      ...(input.systemPrompt.trim()
        ? [{ role: "system" as const, content: input.systemPrompt }]
        : []),
      { role: "user" as const, content: input.prompt.trim() || "(no text)" },
    ],
    workspaceId: input.projectId ?? null,
    workspaceRoot: input.workingDir ?? null,
    // Every member turn of one team run shares the run's scope, so a member
    // dispatched from inside a fusion run is refused with FUSION_RECURSION
    // rather than nesting one orchestrated run inside another (INV-09).
    scopeId: input.runId,
    settings,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.loadHost ? { loadHost: input.loadHost } : {}),
  })
  if (outcome.kind === "skipped") return null
  if (outcome.kind === "refused") {
    throw new RouterFusionRefusalError(
      outcome.code,
      `Router + Fusion refused ${input.teammate.name}'s ${action} turn: ${outcome.code}`,
      {
        reasons: outcome.reasons,
        teammateId: input.teammate.id,
        taskId: input.taskId,
        ...(outcome.runId ? { runId: outcome.runId } : {}),
      }
    )
  }
  input.onCapture?.({ type: "text-delta", delta: outcome.text })
  return {
    text: outcome.text,
    usage: {
      promptTokens: outcome.usage.promptTokens,
      completionTokens: outcome.usage.completionTokens,
      totalTokens: outcome.usage.totalTokens,
    },
  }
}
