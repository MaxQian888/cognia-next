/**
 * `trigger.team` fan-out — fired from `runTeamLifecycle`'s terminal block so
 * a finished team run can start workflows ("on team finished"), mirroring
 * `lib/goal/completion-linkage.ts` / `lib/terminal/command-trigger.ts`.
 *
 * The terminal block is the ONE point every start surface funnels through
 * (workspace buttons, IM dispatch, `action.team.run` nodes, scheduler,
 * remote-control, external bridge, delegation), so hooking here covers them
 * all without touching each trigger path.
 *
 * Safety gates, in order:
 *   1. **Loop prevention** — a workflow triggered by team completion can run
 *      `action.team.run`, whose completion would re-fire this fan-out. The
 *      payload carries `chainDepth`; the `action.team.run` executor threads
 *      it back into the lifecycle, and dispatch stops past
 *      {@link MAX_TEAM_TRIGGER_CHAIN_DEPTH}.
 *   2. **PII red-line** — `finalResult` and `reason` are model output; they
 *      are forwarded only when `hasNoLeakingPii` passes (else omitted), since
 *      the payload lands in run records and downstream LLM nodes via
 *      `{{ $trigger.payload }}`.
 *
 * Best-effort and never throws into the lifecycle's finally block. The
 * shared fan-out mechanics (lazy runtime load, match → dispatch with
 * per-match isolation, PII text gate) live in
 * `lib/runtime/completion-linkage-core.ts`; this wrapper keeps the
 * team-specific chain-depth guard + payload shape.
 */

import { dispatchCompletionFanout, gateModelText } from "@/lib/runtime/completion-linkage-core"

/** Max team-completion → workflow → team chain length before fan-out stops. */
export const MAX_TEAM_TRIGGER_CHAIN_DEPTH = 3

/** Cap on the forwarded finalResult (chars) — keep run records bounded. */
const FINAL_RESULT_MAX_CHARS = 4000

export interface TeamCompletedEvent {
  teamId: string
  teamName: string
  runId: string
  status: "completed" | "failed" | "cancelled"
  reason?: string
  finalResult?: string
  /** Depth of the completion→workflow→team chain that produced this run (0 = root). */
  chainDepth: number
}

/** Fan a terminal team run out to subscribed `trigger.team` workflows. */
export async function dispatchTeamCompletedTriggers(event: TeamCompletedEvent): Promise<void> {
  // Gate 1 — chain-depth loop guard.
  if (event.chainDepth >= MAX_TEAM_TRIGGER_CHAIN_DEPTH) return

  // Gate 2 — PII red-line on model-produced text. Omit-when-unsafe (not
  // empty-string) so downstream templates can distinguish "no result".
  const [reason, finalResult] = await Promise.all([
    gateModelText(event.reason),
    gateModelText(event.finalResult, FINAL_RESULT_MAX_CHARS),
  ])

  await dispatchCompletionFanout({
    kind: "trigger.team",
    match: { teamId: event.teamId, status: event.status },
    payload: {
      // `event` distinguishes user-workflow fan-out payloads from the
      // synthesized team-run marker payload (exactly `{ teamId }`) that
      // shares the "trigger.team" kind — the runs-list filter and the
      // CLI status projection both key on it.
      event: "team.completed",
      teamId: event.teamId,
      teamName: event.teamName,
      runId: event.runId,
      status: event.status,
      ...(reason ? { reason } : {}),
      ...(finalResult ? { finalResult } : {}),
      chainDepth: event.chainDepth + 1,
    },
    binding: { teamId: event.teamId },
  })
}
