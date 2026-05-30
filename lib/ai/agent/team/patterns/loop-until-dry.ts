/**
 * `pattern.loop-until-dry` — for unknown-size discovery (bugs, edge cases),
 * keep spawning finder rounds until `dryRoundsToStop` consecutive rounds return
 * nothing new (deduped against an all-seen set). Simple `while count < N` loops
 * miss the tail; this converges on it. No-silent-caps: when the `maxRounds`
 * ceiling is hit before going dry, it logs that coverage was bounded.
 */

import { registerNodeExecutor, type NodeExecutorRegistration } from "@/lib/workflow/nodes/registry"
import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import {
  findingKey,
  findingsResultSchema,
  type Finding,
  type LoopUntilDryParams,
} from "@/types/agent/ultracode"
import { dispatchStructured } from "../structured-dispatch"
import {
  assignFindingIds,
  fanoutLimit,
  getTeamCtxOrThrow,
  mapSettled,
  nonRetryable,
} from "./_shared"

const FINDINGS_HINT = '{ "findings": [{ "title", "detail", "location"?, "severity"? }] }'

export const LOOP_UNTIL_DRY_KIND = "pattern.loop-until-dry" as const

async function execute(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const teamCtx = getTeamCtxOrThrow(ctx)
  const params = ctx.params as Partial<LoopUntilDryParams>
  const objective = params.objective?.trim()
  const finderPrompt = params.finderPrompt?.trim()
  if (!objective) throw nonRetryable("pattern.loop-until-dry requires 'objective'")
  if (!finderPrompt) throw nonRetryable("pattern.loop-until-dry requires 'finderPrompt'")

  const dryRoundsToStop = Math.max(1, Math.floor(params.dryRoundsToStop ?? 2))
  const maxRounds = Math.max(1, Math.floor(params.maxRounds ?? 4))
  const findersPerRound = Math.max(1, Math.floor(params.findersPerRound ?? 1))

  const seen = new Set<string>()
  const all: Finding[] = []
  let dryStreak = 0
  let round = 0

  while (round < maxRounds && dryStreak < dryRoundsToStop) {
    round += 1
    const knownSummary =
      all.length === 0
        ? "Nothing found yet."
        : `Already found (do NOT repeat these):\n${all.map((f) => `- ${f.title}`).join("\n")}`

    const roundResults = await mapSettled(
      Array.from({ length: findersPerRound }, (_, k) => k),
      fanoutLimit(teamCtx),
      async (k) => {
        const r = await dispatchStructured(
          teamCtx,
          {
            taskId: `${ctx.stepId}:round${round}:finder${k}`,
            prompt:
              `Objective: ${objective}\n\n${finderPrompt}\n\n${knownSummary}\n\n` +
              "Return ONLY findings not already listed above. If you find nothing new, return an empty findings array.",
            signal: ctx.signal,
          },
          findingsResultSchema,
          { schemaHint: FINDINGS_HINT }
        )
        return r.value.findings
      },
      (err, _k, k) => ctx.log("warn", `round ${round} finder ${k} failed: ${String(err)}`)
    )

    const found = roundResults.filter((x): x is Finding[] => x !== null).flat()
    const fresh: Finding[] = []
    for (const f of assignFindingIds(found)) {
      const key = findingKey(f)
      if (seen.has(key)) continue
      seen.add(key)
      fresh.push(f)
    }
    all.push(...fresh)

    if (fresh.length === 0) {
      dryStreak += 1
      ctx.log("info", `round ${round}: 0 new findings (dry streak ${dryStreak}/${dryRoundsToStop})`)
    } else {
      dryStreak = 0
      ctx.log("info", `round ${round}: +${fresh.length} new findings (total ${all.length})`)
    }
  }

  if (dryStreak < dryRoundsToStop) {
    // Bounded by the round ceiling rather than convergence — never silent.
    ctx.log(
      "warn",
      `loop-until-dry hit maxRounds=${maxRounds} before going dry — coverage may be incomplete (${all.length} findings)`
    )
  }

  ctx.log("info", `loop-until-dry complete: ${all.length} findings over ${round} rounds`)
  return { output: { findings: all, rounds: round, converged: dryStreak >= dryRoundsToStop } }
}

export const loopUntilDryNode: NodeExecutorRegistration = {
  kind: LOOP_UNTIL_DRY_KIND,
  typeVersion: 1,
  retryable: false,
  execute,
}

registerNodeExecutor(loopUntilDryNode)
