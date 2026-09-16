/**
 * Cascade workflow (DESIGN §8): CHEAP → VERIFY → [STRONG → VERIFY] → FINALIZE.
 *
 * The cheap deployment answers first and is verified against the run's
 * acceptance profile. A pass finishes the run without the strong deployment
 * ever being called (CAS-01). A failure — a failed or inconclusive check, or
 * structured output that stayed invalid — escalates exactly once, and the
 * reason is a machine code the journal records (CAS-02).
 *
 * The strong deployment gets the original contract and the OBJECTIVE failure
 * report, not the cheap draft: copying the cheap model's guesses forward would
 * anchor the strong one on them. Both stages are billed as what they were.
 *
 * What a cascade never does:
 *  - escalate around a policy refusal — a refusal is not a quality failure,
 *    and asking another model the same thing is bypassing it (CAS-04);
 *  - treat `inconclusive` as a pass — when the strong stage is inconclusive
 *    too, the result is either an explicitly degraded one (the request allowed
 *    it) or a failure, never `accepted` (CAS-03);
 *  - stream — a cheap draft may be replaced, so nothing is delivered until a
 *    stage has passed (verified_buffered, SSE-02).
 *
 * Transient provider failures are retried inside the logical call and do not
 * count as the escalation; they do count against the run's call budget.
 */

import type { Message, RunResult, TaskKind, VerificationReport } from "../contracts/schemas"
import type { VerifierProfile } from "../config/types"
import { acceptanceClaimFor } from "../verify/profiles"
import type { TextBasicRules } from "../verify/text-verifiers"
import { sha256Hex } from "../util/sha256"
import { verifyAnswer, type AnswerVerifierPorts } from "./answer-verifier"
import { formatValid } from "./direct"
import { WorkflowError, performDurableCall } from "./durable-call"
import type { ArtifactStore } from "./ports"
import { untrustedBlock } from "./prompting"

export interface CascadeRunPorts extends AnswerVerifierPorts {
  artifacts: ArtifactStore
}

export type CascadeStage = "cheap" | "strong"

export interface CascadeRunInput {
  runId: string
  cheapDeploymentId: string
  strongDeploymentId: string
  /** Reviews both stages under `text_review`; the strong deployment when absent. */
  reviewerDeploymentId?: string
  messages: Message[]
  maxOutputTokens: number
  /** Per-call reservation of each role. */
  reserveMicrousd: { cheap: number; strong: number; reviewer: number }
  transportAttempts: number
  /** Structured-output repairs for the whole run, not per stage. */
  maxFormatRepairs: number
  deadlineAt: number
  profile: VerifierProfile
  task: TaskKind
  deliversChange: boolean
  allowDegraded: boolean
  jsonSchema?: Record<string, unknown>
  textRules?: TextBasicRules
  fixtureExpectations?: Record<string, unknown>
  signal: AbortSignal
}

/** Why the cheap stage did not finish the run. */
export type EscalationReason =
  "VERIFICATION_FAILED" | "VERIFICATION_INCONCLUSIVE" | "FORMAT_INVALID"

export interface CascadeRunOutcome {
  result: RunResult
  escalated: boolean
  escalationReason: EscalationReason | null
  formatRepairs: number
  reports: Record<CascadeStage, VerificationReport | null>
}

interface StageOutcome {
  text: string
  report: VerificationReport | null
  /** The structured output stayed invalid after the run's repairs were spent. */
  formatInvalid: boolean
}

const FORMAT_REPAIR_INSTRUCTION =
  "The previous answer did not match the required JSON schema. Return only a JSON document that matches the schema; change nothing else."

/** The failed and inconclusive checks of a report, one per line. */
export function failureReportText(
  report: VerificationReport | null,
  reason: EscalationReason
): string {
  if (!report) return `${reason}: the structured output did not match the required schema`
  const lines = report.checks
    .filter((check) => check.status === "failed" || check.status === "inconclusive")
    .map((check) => `${check.check_id} (${check.kind}): ${check.status} — ${check.summary}`)
  return [`${reason} (${report.level}, report ${report.report_id})`, ...lines].join("\n")
}

export async function runCascade(
  ports: CascadeRunPorts,
  input: CascadeRunInput
): Promise<CascadeRunOutcome> {
  let formatRepairs = 0
  const reviewer = input.reviewerDeploymentId ?? input.strongDeploymentId

  const call = (stage: CascadeStage, messages: Message[], stepId: string) =>
    performDurableCall(ports, {
      runId: input.runId,
      logicalStepId: stepId,
      role: stage,
      deploymentId: stage === "cheap" ? input.cheapDeploymentId : input.strongDeploymentId,
      reserveMicrousd: input.reserveMicrousd[stage],
      transportAttempts: input.transportAttempts,
      deadlineAt: input.deadlineAt,
      signal: input.signal,
      request: {
        messages,
        maxOutputTokens: input.maxOutputTokens,
        ...(input.jsonSchema ? { jsonSchema: input.jsonSchema } : {}),
        toolPolicyId: null,
      },
    })

  const runStage = async (stage: CascadeStage, messages: Message[]): Promise<StageOutcome> => {
    await ports.events.emit({ type: "phase.changed", payload: { phase: "cascade", step: stage } })
    let text = (await call(stage, messages, `cascade:${stage}`)).text
    let repairsHere = 0
    while (!formatValid(text, input.jsonSchema)) {
      if (formatRepairs >= input.maxFormatRepairs)
        return { text, report: null, formatInvalid: true }
      formatRepairs++
      repairsHere++
      await ports.events.emit({
        type: "phase.changed",
        payload: { phase: "cascade", step: "format_repair", stage, attempt: formatRepairs },
      })
      text = (
        await call(
          stage,
          [
            ...messages,
            { role: "assistant", content: text.length > 0 ? text : "(empty)" },
            { role: "user", content: FORMAT_REPAIR_INSTRUCTION },
          ],
          `cascade:${stage}:format_repair:${repairsHere}`
        )
      ).text
    }
    await ports.events.emit({ type: "phase.changed", payload: { phase: "verification", stage } })
    const report = await verifyAnswer(ports, {
      runId: input.runId,
      stepPrefix: `cascade:${stage}`,
      profile: input.profile,
      text,
      messages: input.messages,
      ...(input.jsonSchema ? { jsonSchema: input.jsonSchema } : {}),
      ...(input.textRules ? { textRules: input.textRules } : {}),
      ...(input.fixtureExpectations ? { fixtureExpectations: input.fixtureExpectations } : {}),
      reviewerDeploymentId: reviewer,
      reserveMicrousd: input.reserveMicrousd.reviewer,
      transportAttempts: input.transportAttempts,
      deadlineAt: input.deadlineAt,
      signal: input.signal,
    })
    await ports.events.emit({
      type: "verification.completed",
      payload: { stage, status: report.status, level: report.level, report_id: report.report_id },
    })
    return { text, report, formatInvalid: false }
  }

  const finish = async (
    stage: CascadeStage,
    outcome: StageOutcome & { report: VerificationReport },
    degraded: boolean,
    escalationReason: EscalationReason | null,
    reports: CascadeRunOutcome["reports"]
  ): Promise<CascadeRunOutcome> => {
    const stored = await ports.artifacts.put(
      outcome.text,
      input.jsonSchema ? "application/json" : "text/markdown",
      `runs/${input.runId}/answer`
    )
    const quality = acceptanceClaimFor({
      verificationStatus: outcome.report.status,
      profile: input.profile,
      task: input.task,
      deliversChange: input.deliversChange,
      degraded,
    })
    const warnings = [
      ...(escalationReason ? [`escalated:${escalationReason}`] : []),
      ...(formatRepairs > 0 ? ["format_repaired"] : []),
      ...(degraded ? ["verification_inconclusive"] : []),
      ...(outcome.report.level === "schema_only" ? ["verified_format_only"] : []),
    ]
    return {
      result: {
        answer: outcome.text,
        answer_artifact_id: stored.artifactId,
        answer_sha256: sha256Hex(outcome.text),
        mode_executed: "cascade",
        quality_status: quality,
        verification: outcome.report,
        delivery: "answer",
        artifact_ids: [stored.artifactId],
        warnings,
      },
      escalated: stage === "strong",
      escalationReason,
      formatRepairs,
      reports,
    }
  }

  // A policy refusal propagates from here as PolicyRefusalError: never escalated.
  const cheap = await runStage("cheap", input.messages)
  if (!cheap.formatInvalid && cheap.report?.status === "passed") {
    return finish("cheap", { ...cheap, report: cheap.report }, false, null, {
      cheap: cheap.report,
      strong: null,
    })
  }

  const reason: EscalationReason = cheap.formatInvalid
    ? "FORMAT_INVALID"
    : cheap.report?.status === "inconclusive"
      ? "VERIFICATION_INCONCLUSIVE"
      : "VERIFICATION_FAILED"
  await ports.events.emit({
    type: "candidate.rejected",
    payload: {
      stage: "cheap",
      reason,
      ...(cheap.report ? { report_id: cheap.report.report_id, status: cheap.report.status } : {}),
    },
  })
  await ports.events.emit({
    type: "phase.changed",
    payload: { phase: "cascade", step: "escalate", reason },
  })

  const strongMessages: Message[] = [
    ...input.messages,
    {
      role: "user",
      content: [
        "An earlier attempt at this task did not pass the checks below. Solve the task from the request itself; do not assume anything that attempt concluded.",
        untrustedBlock("the objective failure report", failureReportText(cheap.report, reason)),
      ].join("\n\n"),
    },
  ]
  const strong = await runStage("strong", strongMessages)
  const reports = { cheap: cheap.report, strong: strong.report }
  if (strong.formatInvalid || !strong.report) {
    throw new WorkflowError(
      "FORMAT_INVALID",
      "the structured output stayed invalid after escalation",
      {
        escalation_reason: reason,
      }
    )
  }
  if (strong.report.status === "passed") {
    return finish("strong", { ...strong, report: strong.report }, false, reason, reports)
  }
  if (strong.report.status === "inconclusive") {
    if (input.allowDegraded) {
      return finish("strong", { ...strong, report: strong.report }, true, reason, reports)
    }
    throw new WorkflowError(
      "VERIFICATION_INCONCLUSIVE",
      "neither stage could be verified, and the request did not allow a degraded result",
      { report_id: strong.report.report_id, escalation_reason: reason }
    )
  }
  throw new WorkflowError("VERIFICATION_FAILED", "the escalated answer failed its checks", {
    report_id: strong.report.report_id,
    escalation_reason: reason,
  })
}
