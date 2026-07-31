/**
 * `select` + `judge` strategy: ask a model to pick the best of N independent
 * agent attempts, using the outputs already captured in the reconcile ledger
 * (no extra worktree work). The model runner is injected so this unit-tests
 * without an LLM; the runtime wires it to `executeAgent`.
 */

import type { ReconcileCandidate } from "./reconciler"

export interface JudgeDeps {
  /** Run a one-shot text completion, returning the model's reply. */
  run: (prompt: string) => Promise<string>
}

/** Build the reviewer prompt from the eligible candidates' outputs. */
export function buildJudgePrompt(candidates: ReconcileCandidate[]): string {
  const blocks = candidates
    .map(
      (c, i) =>
        `[${i + 1}] key=${c.handle.key} branch=${c.handle.branch}\n${(c.output ?? "").slice(0, 2000)}`
    )
    .join("\n\n")
  return (
    `You are reviewing ${candidates.length} independent attempts at the same task. ` +
    `Pick the single best one. Reply with ONLY its key (the value after "key=").\n\n${blocks}`
  )
}

/** Resolve the model's reply to one of the candidate keys, or null. */
export function matchKey(text: string, candidates: ReconcileCandidate[]): string | null {
  const t = text.trim()
  for (const c of candidates) if (t === c.handle.key) return c.handle.key
  // Longest keys first so a substring match doesn't pick a key that is a
  // prefix of the intended one.
  const byLen = [...candidates].sort((a, b) => b.handle.key.length - a.handle.key.length)
  for (const c of byLen) if (t.includes(c.handle.key)) return c.handle.key
  return null
}

/**
 * Return the winning candidate key per the injected judge, falling back to the
 * first successful candidate on any ambiguity or model failure. `null` only
 * when there is no successful candidate at all.
 */
export async function selectWinnerByJudge(
  candidates: ReconcileCandidate[],
  deps: JudgeDeps
): Promise<string | null> {
  const eligible = candidates.filter((c) => c.ok)
  if (eligible.length === 0) return null
  if (eligible.length === 1) return eligible[0]!.handle.key

  let text: string
  try {
    text = await deps.run(buildJudgePrompt(eligible))
  } catch {
    return eligible[0]!.handle.key
  }
  return matchKey(text, eligible) ?? eligible[0]!.handle.key
}
