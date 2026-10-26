/**
 * Final selection (ADR-0237).
 *
 * Deterministic evidence decides first; a model judge only breaks ties, and
 * when the decision is still uncertain the base harness stays. This reverses
 * the failure Harness² reports, where a judge picked a run that scored 55 over
 * one that scored 95: a check result is a fact and an impression may not
 * overrule it.
 *
 * 1. Standing. Each harness's rollouts are ranked by
 *    {@link deterministicStanding} (no error, delivered, fewer failed checks,
 *    more passed checks, fewer tool failures). A candidate counts at its worst
 *    replicate, the base at its best and worst: improvements must beat the
 *    base's best run, and only a run below the base's worst is a regression.
 * 2. Regressions are out. A final that dominates the base is in front; if one
 *    alone dominates, it is chosen without a judge.
 * 3. Otherwise the contenders (finals tied with the base, plus the base, or
 *    the tied dominant finals) go to a blind judge under seeded anonymous ids.
 *    Unlike Harness², the base is among them, and with k = 1 the comparison is
 *    a blind A/B against the base.
 * 4. A judge failure, a low-confidence verdict or a verdict for the base keeps
 *    the base whenever the base is a contender.
 */

import { createSeededRandom } from "@cognia/eval-core/seeded-random"
import type { HarnessExecutionEvidence } from "@/types/harness/evolution"
import type { HarnessComponentsV1 } from "@/types/harness/snapshot"
import { extractEmbeddedJsonObject } from "./checks"
import { compareStanding, deterministicStanding } from "./evidence"
import { alwaysOnText } from "./tree"

export const BASE_LABEL = "base"

export interface SelectionHarness {
  label: string
  snapshotId: string
  components: HarnessComponentsV1
  /** One evidence per replicate. */
  evidence: readonly HarnessExecutionEvidence[]
}

export interface JudgeEntry {
  id: string
  evidence: HarnessExecutionEvidence
}

export interface JudgeVerdict {
  best: string
  ranking: string[]
  confidence: "high" | "medium" | "low"
  evidence: Record<string, string>
}

/** Calls the selector model with anonymised entries. `null` when no verdict could be had. */
export type SelectionJudge = (entries: readonly JudgeEntry[]) => Promise<JudgeVerdict | null>

export type SelectionMethod = "deterministic" | "judge" | "tie-break" | "no-candidate"

export interface SelectionResult {
  outcome: "adopt" | "keep-base"
  chosenLabel?: string
  chosenSnapshotId?: string
  method: SelectionMethod
  reason: string
  /** Labels judged a regression against the base. */
  regressed: string[]
  /** Labels that beat the base on deterministic evidence. */
  dominant: string[]
  /** Anonymous id → label, when a judge ran. */
  anonymized?: Record<string, string>
  verdict?: JudgeVerdict
}

function worst(evidence: readonly HarnessExecutionEvidence[]): number[] {
  return evidence.map(deterministicStanding).reduce((a, b) => (compareStanding(a, b) <= 0 ? a : b))
}

function best(evidence: readonly HarnessExecutionEvidence[]): number[] {
  return evidence.map(deterministicStanding).reduce((a, b) => (compareStanding(a, b) >= 0 ? a : b))
}

function meanCost(evidence: readonly HarnessExecutionEvidence[]): number {
  const priced = evidence.filter((e) => typeof e.metrics.costUsd === "number")
  if (priced.length === 0) {
    return evidence.reduce((s, e) => s + e.metrics.inputTokens + e.metrics.outputTokens, 0) / 1e6
  }
  return priced.reduce((s, e) => s + (e.metrics.costUsd as number), 0) / priced.length
}

/** Cheaper first, then the smaller always-on text, then label order. */
function tieBreak(entries: readonly SelectionHarness[]): SelectionHarness {
  return [...entries].sort(
    (a, b) =>
      meanCost(a.evidence) - meanCost(b.evidence) ||
      alwaysOnText(a.components).length - alwaysOnText(b.components).length ||
      a.label.localeCompare(b.label)
  )[0]
}

/** Seeded anonymous ids ("R1", "R2", …) in a seeded order. */
export function anonymize(labels: readonly string[], seed: number): Record<string, string> {
  const random = createSeededRandom(seed)
  const order = [...labels]
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return Object.fromEntries(order.map((label, i) => [`R${i + 1}`, label]))
}

/** Read the selector's JSON answer. `null` when it does not name a known id. */
export function parseJudgeVerdict(text: string, ids: readonly string[]): JudgeVerdict | null {
  const value = extractEmbeddedJsonObject(text) as Record<string, unknown> | undefined
  if (!value || typeof value !== "object") return null
  const known = new Set(ids)
  const bestId = typeof value.best === "string" ? value.best.trim() : ""
  if (!known.has(bestId)) return null
  const ranking = Array.isArray(value.ranking)
    ? value.ranking.filter((x): x is string => typeof x === "string" && known.has(x))
    : [bestId]
  const confidence =
    value.confidence === "high" || value.confidence === "medium" ? value.confidence : "low"
  const evidence: Record<string, string> = {}
  if (value.evidence && typeof value.evidence === "object" && !Array.isArray(value.evidence)) {
    for (const [k, v] of Object.entries(value.evidence as Record<string, unknown>)) {
      if (known.has(k) && typeof v === "string") evidence[k] = v
    }
  }
  return { best: bestId, ranking: ranking.length ? ranking : [bestId], confidence, evidence }
}

export async function selectFinal(input: {
  base: SelectionHarness
  finals: readonly SelectionHarness[]
  seed: number
  judge: SelectionJudge
}): Promise<SelectionResult> {
  const { base } = input
  const baseBest = best(base.evidence)
  const baseWorst = worst(base.evidence)
  const regressed: string[] = []
  const dominant: SelectionHarness[] = []
  const tied: SelectionHarness[] = []
  for (const final of input.finals) {
    if (final.evidence.length === 0) continue
    const standing = worst(final.evidence)
    if (compareStanding(standing, baseWorst) < 0) regressed.push(final.label)
    else if (compareStanding(standing, baseBest) > 0) dominant.push(final)
    else tied.push(final)
  }
  const common = { regressed, dominant: dominant.map((d) => d.label) }

  const adopt = (h: SelectionHarness, method: SelectionMethod, reason: string) => ({
    outcome: "adopt" as const,
    chosenLabel: h.label,
    chosenSnapshotId: h.snapshotId,
    method,
    reason,
    ...common,
  })
  const keep = (method: SelectionMethod, reason: string) => ({
    outcome: "keep-base" as const,
    method,
    reason,
    ...common,
  })

  let contenders: SelectionHarness[]
  let baseContends: boolean
  if (dominant.length > 0) {
    const top = dominant.reduce((a, b) =>
      compareStanding(worst(a.evidence), worst(b.evidence)) >= 0 ? a : b
    )
    const topStanding = worst(top.evidence)
    const atTop = dominant.filter((d) => compareStanding(worst(d.evidence), topStanding) === 0)
    if (atTop.length === 1) {
      return adopt(
        top,
        "deterministic",
        `${top.label} beat every base rollout on deterministic evidence (delivery, checks, tool errors).`
      )
    }
    contenders = atTop
    baseContends = false
  } else if (tied.length > 0) {
    contenders = [...tied, base]
    baseContends = true
  } else {
    return keep(
      "no-candidate",
      input.finals.length === 0
        ? "No final harness was produced."
        : "No final matched the base's deterministic results."
    )
  }

  const mapping = anonymize(
    contenders.map((c) => c.label),
    input.seed
  )
  const byLabel = new Map(contenders.map((c) => [c.label, c]))
  const entries: JudgeEntry[] = Object.entries(mapping).map(([id, label]) => ({
    id,
    // The judge sees one run per harness: the worst for a candidate, which is
    // the run it was ranked by, and the best for the base, which is the bar.
    evidence: (() => {
      const h = byLabel.get(label) as SelectionHarness
      const pick = label === BASE_LABEL ? best : worst
      const target = pick(h.evidence)
      return (
        h.evidence.find((e) => compareStanding(deterministicStanding(e), target) === 0) ??
        h.evidence[0]
      )
    })(),
  }))

  let verdict: JudgeVerdict | null = null
  try {
    verdict = await input.judge(entries)
  } catch {
    verdict = null
  }
  const withJudge = { anonymized: mapping, ...(verdict ? { verdict } : {}) }

  if (!verdict) {
    if (baseContends) {
      return { ...keep("judge", "The judge gave no usable verdict; the base stays."), ...withJudge }
    }
    const chosen = tieBreak(contenders)
    return {
      ...adopt(
        chosen,
        "tie-break",
        `Tied finals all beat the base; ${chosen.label} is the cheapest.`
      ),
      ...withJudge,
    }
  }
  const chosenLabel = mapping[verdict.best]
  if (chosenLabel === BASE_LABEL) {
    return { ...keep("judge", "The blind judge preferred the base run."), ...withJudge }
  }
  if (verdict.confidence === "low" && baseContends) {
    return {
      ...keep("judge", `The judge leaned to ${chosenLabel} with low confidence; the base stays.`),
      ...withJudge,
    }
  }
  const chosen = byLabel.get(chosenLabel) as SelectionHarness
  return {
    ...adopt(
      chosen,
      "judge",
      `The blind judge preferred ${chosenLabel} (${verdict.confidence} confidence): ${
        verdict.evidence[verdict.best] ?? "no reason given"
      }`
    ),
    ...withJudge,
  }
}
