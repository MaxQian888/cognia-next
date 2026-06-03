/**
 * `pattern.adversarial-verify` — spawn N independent skeptics per finding, each
 * prompted to REFUTE it (default to "not real" when uncertain). A finding is
 * killed unless more skeptics confirm than refute. When `lenses` is set, each
 * skeptic gets a distinct angle (correctness / security / perf / repro) so the
 * panel catches failure modes redundancy can't — perspective-diverse verify.
 *
 * Verifiers run tool-enabled (they can actually read code / reproduce), per the
 * confirmed verifier-tools decision; `dispatchTeammate` picks the sidecar on
 * desktop automatically.
 */

import { registerNodeExecutor, type NodeExecutorRegistration } from "@/lib/workflow/nodes/registry"
import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import {
  verdictSchema,
  type AdversarialVerifyParams,
  type Finding,
  type Verdict,
  type VerifierLens,
} from "@/types/agent/ultracode"
import { dispatchStructured } from "../structured-dispatch"
import {
  collectFindings,
  fanoutLimit,
  getTeamCtxOrThrow,
  mapSettled,
  renderFinding,
} from "./_shared"

const VERDICT_HINT =
  '{ "real": boolean, "reasoning": "…", "lens"?: "correctness|security|perf|repro" }'

const LENS_GUIDANCE: Record<VerifierLens, string> = {
  correctness:
    "Does the finding describe a real logic / behavior defect? Check the claim against how the code actually executes.",
  security:
    "Is this an exploitable security issue? Consider the threat model and whether an attacker can actually trigger it.",
  perf: "Is the performance impact real and material at realistic scale? Estimate the cost; dismiss micro-claims.",
  repro:
    "Try to actually reproduce it — read the cited code / run the relevant check. If you cannot reproduce it, it is not real.",
}

export const ADVERSARIAL_VERIFY_KIND = "pattern.adversarial-verify" as const

export interface VerifiedFinding {
  finding: Finding
  verdicts: Verdict[]
  realVotes: number
  refuteVotes: number
  survives: boolean
}

async function execute(ctx: StepExecutionContext): Promise<StepExecutionResult> {
  const teamCtx = getTeamCtxOrThrow(ctx)
  const params = ctx.params as Partial<AdversarialVerifyParams> & { findings?: Finding[] }
  const objective = params.objective?.trim() ?? ""

  // Findings come from upstream sweep/loop nodes; an explicit param wins for tests.
  const findings =
    params.findings && params.findings.length > 0 ? params.findings : collectFindings(ctx.upstream)
  if (findings.length === 0) {
    ctx.log("info", "adversarial-verify: no upstream findings to verify")
    return { output: { findings: [], killed: [], verified: [] } }
  }

  const lenses = params.lenses?.filter((l): l is VerifierLens => !!l)
  const skeptics =
    lenses && lenses.length > 0 ? lenses.length : Math.max(1, params.skepticsPerFinding ?? 3)

  ctx.log(
    "info",
    `adversarial-verify: ${findings.length} findings × ${skeptics} skeptics${lenses?.length ? ` (lenses: ${lenses.join(", ")})` : ""}`
  )

  // Flatten to (finding, skepticIndex) jobs so the whole panel runs under one
  // concurrency bound rather than serializing per finding.
  const jobs = findings.flatMap((finding, fi) =>
    Array.from({ length: skeptics }, (_, si) => ({ finding, fi, si }))
  )

  const verdictResults = await mapSettled(
    jobs,
    fanoutLimit(teamCtx),
    async (job, _idx) => {
      const lens = lenses && lenses.length > 0 ? lenses[job.si % lenses.length] : undefined
      const lensNote = lens ? `\n\nVerification lens — ${lens}: ${LENS_GUIDANCE[lens]}` : ""
      const r = await dispatchStructured(
        teamCtx,
        {
          taskId: `${ctx.stepId}:verify:${job.fi}:${job.si}`,
          prompt:
            `${objective ? `Objective: ${objective}\n\n` : ""}` +
            `Try to REFUTE this finding. Default to real=false if you are not convinced.\n\n` +
            `Finding:\n${renderFinding(job.finding)}${lensNote}`,
          signal: ctx.signal,
        },
        verdictSchema,
        { schemaHint: VERDICT_HINT }
      )
      return { fi: job.fi, verdict: { ...r.value, ...(lens ? { lens } : {}) } }
    },
    (err, job, idx) =>
      ctx.log("warn", `verify job ${idx} (finding ${job.fi}) failed: ${String(err)}`)
  )

  // Tally per finding.
  const byFinding = new Map<number, Verdict[]>()
  for (const res of verdictResults) {
    if (!res) continue
    const list = byFinding.get(res.fi) ?? []
    list.push(res.verdict)
    byFinding.set(res.fi, list)
  }

  const verified: VerifiedFinding[] = findings.map((finding, fi) => {
    const verdicts = byFinding.get(fi) ?? []
    const realVotes = verdicts.filter((v) => v.real).length
    const refuteVotes = verdicts.length - realVotes
    // Survives only with strictly more confirmations than refutals; a tie (or
    // a finding whose skeptics all errored out) is killed — conservative.
    const survives = verdicts.length > 0 && realVotes > refuteVotes
    return { finding, verdicts, realVotes, refuteVotes, survives }
  })

  const survivors = verified.filter((v) => v.survives).map((v) => v.finding)
  const killed = verified.filter((v) => !v.survives).map((v) => v.finding)
  ctx.log(
    "info",
    `adversarial-verify complete: ${survivors.length} survived, ${killed.length} killed`
  )

  return { output: { findings: survivors, killed, verified } }
}

export const adversarialVerifyNode: NodeExecutorRegistration = {
  kind: ADVERSARIAL_VERIFY_KIND,
  typeVersion: 1,
  retryable: false,
  execute,
}

registerNodeExecutor(adversarialVerifyNode)
