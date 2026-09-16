/**
 * Panel Fusion (DESIGN §9):
 *
 *   PREPARE → PANEL_PARALLEL → VALIDATE_CANDIDATES → JUDGE
 *     → [VERIFY_EVIDENCE → REJUDGE] → SYNTHESIZE → FINAL_VERIFY → FINALIZE
 *
 * PREPARE proves the work fits before a byte is sent: every window the
 * candidates' answers will pass through (PAN-08), and the money every
 * necessary stage needs — candidates, judge, synthesis, final check — held as
 * stage reservations up front (BUD-02). Optional evidence rounds spend what is
 * left.
 *
 * Candidates are independent: each reads the task contract and the common
 * evidence, and nothing of another candidate (PAN-01). Each may take one round
 * of read-only tools the runtime offers, and nothing else — a request for any
 * tool the policy does not name is refused by the runtime whatever the text
 * around it says (AUTH-05, PAN-07).
 *
 * A candidate's citations are checked before the judge sees them: a reference
 * that does not resolve in this tenant, that this run may not read, or whose
 * content changed, is dropped (PAN-05). The judge reviews anonymous candidates
 * in an order fixed by the run, and under `evidence_review` a claim counts as
 * supported only when it has evidence of its own — agreement between
 * candidates is not evidence (PAN-04). One round of targeted verification and
 * one rejudge at most (PAN-07).
 *
 * The synthesizer may assert only supported claims; the final check refuses a
 * synthesis that leans on anything else, loses a citation, or that the review
 * call says introduced a new unsupported claim (PAN-06). Two of two, or an
 * allowed two of three, is a panel (`panel_partial` when a member failed); one
 * candidate is `FUSION_INSUFFICIENT_CANDIDATES`, or — when the request allowed
 * it — an explicitly degraded single-candidate result that is not a fusion
 * success (PAN-02, PAN-03). Nothing streams: only the verified synthesis is an
 * answer (SSE-02).
 */

import { z } from "zod"

import type {
  Claim,
  Contradiction,
  EvidenceRef,
  JudgeReport,
  Message,
  RunResult,
  TaskKind,
  VerificationCheck,
  VerificationReport,
  VerificationRequest,
} from "../contracts/schemas"
import { CONTRACT_SCHEMA_VERSION } from "../contracts/schemas"
import type { VerifierProfile } from "../config/types"
import { estimateTokens } from "../routing/features"
import { checkEvidenceRefs } from "../verify/evidence"
import { acceptanceClaimFor } from "../verify/profiles"
import {
  parseJsonDocument,
  TEXT_VERIFIER_VERSION,
  verifySchemaFixture,
  verifyTextBasic,
} from "../verify/text-verifiers"
import { sha256Hex, uuidFromName } from "../util/sha256"
import {
  compactionDecision,
  compactTranscript,
  planPanelContext,
  transcriptTokens,
} from "./context-window"
import {
  BudgetRefusedError,
  PolicyRefusalError,
  WorkflowError,
  performDurableCall,
  type DurableCallPorts,
  type DurableCallResult,
} from "./durable-call"
import type {
  ArtifactStore,
  EvidenceResolver,
  ToolDescriptor,
  ToolIntent,
  ToolReceipt,
  ToolRuntime,
} from "./ports"
import { roleMessages, seededOrder, taskContract, untrustedBlock } from "./prompting"

export const PANEL_VERIFIER_VERSION = "panel-verify-1"
export const PANEL_MEMBER_STAGE = "panel:members"
export const PANEL_TAIL_STAGE = "panel:tail"
/** System prompt and framing per call, reserved in every window. */
const OVERHEAD_TOKENS = 1_500
/** Excerpt of one evidence artifact shown to the judge. */
const EVIDENCE_EXCERPT_CHARS = 1_200

export type PanelMemberRole = "panel_a" | "panel_b" | "panel_c"

export interface PanelMember {
  role: PanelMemberRole
  deploymentId: string
  contextLimit: number
}

export interface PanelRunPorts extends DurableCallPorts {
  artifacts: ArtifactStore
  newId: () => string
  evidence: EvidenceResolver
  tools?: ToolRuntime
}

export interface PanelLimits {
  /** Valid candidates a complete panel needs (spec: 2). */
  minCandidates: number
  /** Targeted verification rounds, each followed by one rejudge (spec: 1). */
  evidenceRounds: number
  /** Structured-output repairs across judge, synthesis and final check (spec: 1). */
  maxFormatRepairs: number
  transportAttempts: number
  /** Tool calls one candidate may make in its single tool round. */
  memberToolCalls: number
  /** Verification requests the runtime executes per round. */
  verificationRequests: number
}

export interface PanelRunInput {
  runId: string
  members: PanelMember[]
  judge: { deploymentId: string; contextLimit: number }
  synthesizer: { deploymentId: string; contextLimit: number }
  messages: Message[]
  /** Evidence every candidate starts from; already stored as artifacts of this run. */
  commonEvidence: Array<{ ref: EvidenceRef; excerpt: string }>
  outputTokens: { member: number; judge: number; synthesizer: number; finalCheck: number }
  /** The per-call reservation for a role, given its worst-case input and output. */
  reserveFor: (
    role: string,
    deploymentId: string,
    inputTokens: number,
    outputTokens: number
  ) => number
  limits: PanelLimits
  profile: VerifierProfile
  task: TaskKind
  deliversChange: boolean
  allowDegraded: boolean
  /** The read-only tool policy candidates may request tools under; null offers none. */
  memberToolPolicyId: string | null
  /** The policy the runtime executes the judge's verification requests under; null leaves them unresolved. */
  verificationToolPolicyId: string | null
  /** The caller's schema for the final answer, when it asked for structured output. */
  jsonSchema?: Record<string, unknown>
  deadlineAt: number
  signal: AbortSignal
}

export interface PanelCandidateOutcome {
  role: PanelMemberRole
  /** The anonymous label the judge saw; null for a candidate that never reached the judge. */
  label: string | null
  status: "valid" | "failed"
  reason: string | null
  candidateId: string
  artifactId: string | null
  rejectedEvidence: number
}

export interface PanelRunOutcome {
  result: RunResult
  partial: boolean
  degradedToSingle: boolean
  candidates: PanelCandidateOutcome[]
  judgeReport: JudgeReport | null
  supportedClaimIds: string[]
  /** Claims the judge supported that had no evidence of their own (evidence_review). */
  unverifiedClaimIds: string[]
  formatRepairs: number
  memberOutputTokens: number
}

// ── model-facing output schemas ───────────────────────────────────────────────

const EVIDENCE_REF_JSON = {
  type: "object",
  required: ["artifact_id", "content_sha256", "locator", "retrieved_at"],
  additionalProperties: false,
  properties: {
    artifact_id: { type: "string" },
    content_sha256: { type: "string" },
    locator: { type: "string" },
    retrieved_at: { type: "string" },
  },
}

export const CANDIDATE_OUTPUT_SCHEMA = {
  type: "object",
  required: ["answer", "claims", "assumptions", "open_questions"],
  additionalProperties: false,
  properties: {
    answer: { type: "string" },
    claims: {
      type: "array",
      items: {
        type: "object",
        required: ["claim_id", "text", "evidence_refs"],
        additionalProperties: false,
        properties: {
          claim_id: { type: "string" },
          text: { type: "string" },
          evidence_refs: { type: "array", items: EVIDENCE_REF_JSON },
        },
      },
    },
    assumptions: { type: "array", items: { type: "string" } },
    open_questions: { type: "array", items: { type: "string" } },
  },
} as const

export const JUDGE_OUTPUT_SCHEMA = {
  type: "object",
  required: [
    "supported_claim_ids",
    "rejected_claim_ids",
    "contradictions",
    "missing_requirements",
    "verification_requests",
    "ready_to_synthesize",
  ],
  additionalProperties: false,
  properties: {
    supported_claim_ids: { type: "array", items: { type: "string" } },
    rejected_claim_ids: { type: "array", items: { type: "string" } },
    contradictions: {
      type: "array",
      items: {
        type: "object",
        required: ["topic", "claim_ids", "resolution", "summary", "evidence_refs"],
        additionalProperties: false,
        properties: {
          topic: { type: "string" },
          claim_ids: { type: "array", items: { type: "string" } },
          resolution: { type: "string", enum: ["resolved", "unresolved"] },
          summary: { type: "string" },
          evidence_refs: { type: "array", items: EVIDENCE_REF_JSON },
        },
      },
    },
    missing_requirements: { type: "array", items: { type: "string" } },
    verification_requests: {
      type: "array",
      items: {
        type: "object",
        required: ["request_id", "kind", "question", "artifact_ids"],
        additionalProperties: false,
        properties: {
          request_id: { type: "string" },
          kind: { type: "string", enum: ["artifact_read", "source_check", "compute", "test"] },
          question: { type: "string" },
          artifact_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
    ready_to_synthesize: { type: "boolean" },
  },
} as const

export const SYNTHESIS_OUTPUT_SCHEMA = {
  type: "object",
  required: ["answer", "used_claim_ids", "uncertainties", "citations"],
  additionalProperties: false,
  properties: {
    answer: { type: "string" },
    used_claim_ids: { type: "array", items: { type: "string" } },
    uncertainties: { type: "array", items: { type: "string" } },
    citations: {
      type: "array",
      items: {
        type: "object",
        required: ["claim_id", "artifact_id"],
        additionalProperties: false,
        properties: { claim_id: { type: "string" }, artifact_id: { type: "string" } },
      },
    },
  },
} as const

export const FINAL_CHECK_OUTPUT_SCHEMA = {
  type: "object",
  required: ["status", "new_unsupported_claims", "missing_requirements", "lost_citations"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["passed", "failed", "inconclusive"] },
    new_unsupported_claims: { type: "array", items: { type: "string" } },
    missing_requirements: { type: "array", items: { type: "string" } },
    lost_citations: { type: "array", items: { type: "string" } },
  },
} as const

const CandidateOutput = z.object({
  answer: z.string().min(1),
  claims: z.array(
    z.object({
      claim_id: z.string().min(1),
      text: z.string().min(1),
      evidence_refs: z.array(z.unknown()),
    })
  ),
  assumptions: z.array(z.string()),
  open_questions: z.array(z.string()),
})

const JudgeOutput = z.object({
  supported_claim_ids: z.array(z.string()),
  rejected_claim_ids: z.array(z.string()),
  contradictions: z.array(
    z.object({
      topic: z.string(),
      claim_ids: z.array(z.string()).min(1),
      resolution: z.enum(["resolved", "unresolved"]),
      summary: z.string(),
      evidence_refs: z.array(z.unknown()),
    })
  ),
  missing_requirements: z.array(z.string()),
  verification_requests: z.array(
    z.object({
      request_id: z.string(),
      kind: z.enum(["artifact_read", "source_check", "compute", "test"]),
      question: z.string(),
      artifact_ids: z.array(z.string()),
    })
  ),
  ready_to_synthesize: z.boolean(),
})

type JudgeOutputValue = z.infer<typeof JudgeOutput>

const SynthesisOutput = z.object({
  answer: z.string(),
  used_claim_ids: z.array(z.string()),
  uncertainties: z.array(z.string()),
  citations: z.array(z.object({ claim_id: z.string(), artifact_id: z.string() })),
})

const FinalCheckOutput = z.object({
  status: z.enum(["passed", "failed", "inconclusive"]),
  new_unsupported_claims: z.array(z.string()),
  missing_requirements: z.array(z.string()),
  lost_citations: z.array(z.string()),
})

const FORMAT_REPAIR_INSTRUCTION =
  "The previous answer did not match the required JSON schema. Return only a JSON document that matches the schema; change nothing else."

/** The labels candidates are shown under; the run seed decides who gets which. */
const LABELS = ["A", "B", "C"] as const

// ── internal shapes ───────────────────────────────────────────────────────────

interface ValidatedClaim extends Claim {
  /** `<label>.<claim_id>` — unique across the panel. */
  globalId: string
  candidateLabel: string
}

interface ValidCandidate {
  member: PanelMember
  candidateId: string
  label: string
  answer: string
  claims: ValidatedClaim[]
  assumptions: string[]
  openQuestions: string[]
  artifactId: string
  rejectedEvidence: number
}

type MemberResult =
  | { status: "valid"; candidate: Omit<ValidCandidate, "label" | "claims"> & { claims: Claim[] } }
  | { status: "failed"; member: PanelMember; candidateId: string; reason: string }

/**
 * What ends the whole panel rather than one member: a policy refusal (another
 * candidate's answer would be a way around it), cancellation, the deadline, and
 * anything that is not a workflow outcome at all — an infrastructure fault the
 * host decides about. A member's own call failing, going unanswered or being
 * refused money only fails that member.
 */
function isFatal(error: unknown): boolean {
  if (error instanceof PolicyRefusalError) return true
  if (error instanceof WorkflowError) {
    return error.code === "CANCELLED" || error.code === "DEADLINE_EXCEEDED"
  }
  return true
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function refusedReceipt(intent: ToolIntent, code: string): ToolReceipt {
  return {
    operationId: `refused:${intent.id}`,
    toolCallId: intent.id,
    name: intent.name,
    status: "refused",
    refusalCode: code,
    evidence: [],
    summary: `refused: ${code}`,
  }
}

function receiptText(receipts: readonly ToolReceipt[]): string {
  return receipts
    .map((receipt) =>
      [
        `tool ${receipt.name} (${receipt.toolCallId}): ${receipt.status}${receipt.refusalCode ? ` — ${receipt.refusalCode}` : ""}`,
        ...receipt.evidence.map(
          (ref) =>
            `evidence: ${JSON.stringify({
              artifact_id: ref.artifact_id,
              content_sha256: ref.content_sha256,
              locator: ref.locator,
              retrieved_at: ref.retrieved_at,
            })}`
        ),
        receipt.summary,
      ].join("\n")
    )
    .join("\n\n")
}

function checkOf(
  check_id: string,
  kind: string,
  status: VerificationCheck["status"],
  summary: string,
  executed_by: VerificationCheck["executed_by"] = "runtime",
  artifact_refs: string[] = []
): VerificationCheck {
  return { check_id, kind, status, summary, executed_by, artifact_refs }
}

function aggregate(checks: readonly VerificationCheck[]): VerificationReport["status"] {
  if (checks.some((c) => c.status === "failed")) return "failed"
  if (checks.some((c) => c.status === "inconclusive")) return "inconclusive"
  return "passed"
}

// ── the workflow ──────────────────────────────────────────────────────────────

export async function runPanel(
  ports: PanelRunPorts,
  input: PanelRunInput
): Promise<PanelRunOutcome> {
  const { limits } = input
  const contract = taskContract(input.messages)
  const seed = sha256Hex(input.runId)
  let formatRepairs = 0

  // ── PREPARE: windows ──
  const commonEvidenceText = input.commonEvidence
    .map((entry) => `${entry.ref.artifact_id} ${entry.ref.locator}\n${entry.excerpt}`)
    .join("\n\n")
  const taskTokens = estimateTokens(contract) + estimateTokens(commonEvidenceText)
  const members = input.members.slice(0, LABELS.length)
  const plan = planPanelContext({
    taskTokens,
    members: members.length,
    memberOutputTokens: input.outputTokens.member,
    judge: { contextLimit: input.judge.contextLimit, outputTokens: input.outputTokens.judge },
    synthesizer: {
      contextLimit: input.synthesizer.contextLimit,
      outputTokens: input.outputTokens.synthesizer,
    },
    finalCheckOutputTokens: input.outputTokens.finalCheck,
    evidenceTokens: Math.ceil((EVIDENCE_EXCERPT_CHARS / 4) * limits.verificationRequests),
    overheadTokens: OVERHEAD_TOKENS,
  })
  if (!plan.ok) {
    throw new WorkflowError(
      "CONTEXT_PRECHECK_FAILED",
      `the panel does not fit the ${plan.window} window`,
      {
        window: plan.window,
        need_tokens: plan.needTokens,
        limit_tokens: plan.limitTokens,
      }
    )
  }
  const memberOut = plan.memberOutputTokens
  await ports.events.emit({
    type: "phase.changed",
    payload: {
      phase: "prepare",
      members: members.length,
      member_output_tokens: memberOut,
      output_bound_lowered: plan.adjusted,
    },
  })

  // ── PREPARE: money for every necessary stage, before any call ──
  const memberInputTokens = OVERHEAD_TOKENS + taskTokens
  const memberReserve = members.map((member) =>
    input.reserveFor(member.role, member.deploymentId, memberInputTokens, memberOut)
  )
  const judgeReserve = input.reserveFor(
    "judge",
    input.judge.deploymentId,
    plan.judgeInputTokens,
    input.outputTokens.judge
  )
  const synthReserve = input.reserveFor(
    "synthesizer",
    input.synthesizer.deploymentId,
    plan.synthesizerInputTokens,
    input.outputTokens.synthesizer
  )
  const finalReserve = input.reserveFor(
    "judge",
    input.judge.deploymentId,
    plan.finalCheckInputTokens,
    input.outputTokens.finalCheck
  )
  const memberStage = memberReserve.reduce((sum, amount) => sum + amount, 0)
  const tailStage = judgeReserve + synthReserve + finalReserve
  const heldMembers = await ports.ledger.reserveStage(PANEL_MEMBER_STAGE, memberStage)
  if (heldMembers.kind === "refused") throw new BudgetRefusedError(heldMembers.code)
  const heldTail = await ports.ledger.reserveStage(PANEL_TAIL_STAGE, tailStage)
  if (heldTail.kind === "refused") {
    await ports.ledger.releaseStage(PANEL_MEMBER_STAGE)
    throw new BudgetRefusedError(heldTail.code)
  }
  const stageLeft: Record<string, number> = {
    [PANEL_MEMBER_STAGE]: memberStage,
    [PANEL_TAIL_STAGE]: tailStage,
  }
  const fromStage = (stageId: string, amount: number): string | undefined => {
    if (stageLeft[stageId] <= 0) return undefined
    stageLeft[stageId] = Math.max(0, stageLeft[stageId] - amount)
    return stageId
  }

  const call = (
    role: string,
    deploymentId: string,
    logicalStepId: string,
    messages: Message[],
    options: {
      reserve: number
      stageId?: string
      maxOutputTokens: number
      jsonSchema?: Record<string, unknown>
      tools?: ToolDescriptor[]
      toolPolicyId?: string | null
    }
  ): Promise<DurableCallResult> =>
    performDurableCall(ports, {
      runId: input.runId,
      logicalStepId,
      role,
      deploymentId,
      reserveMicrousd: options.reserve,
      ...(options.stageId ? { fromStageId: options.stageId } : {}),
      transportAttempts: limits.transportAttempts,
      deadlineAt: input.deadlineAt,
      signal: input.signal,
      request: {
        messages,
        maxOutputTokens: options.maxOutputTokens,
        ...(options.jsonSchema ? { jsonSchema: options.jsonSchema } : {}),
        toolPolicyId: options.toolPolicyId ?? null,
        ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
      },
    })

  /** A structured call with the run's shared format repair. Null when it stayed invalid. */
  const callForJson = async <T>(
    role: string,
    deploymentId: string,
    logicalStepId: string,
    messages: Message[],
    schema: Record<string, unknown>,
    parser: z.ZodType<T>,
    options: { reserve: number; stageId?: string; maxOutputTokens: number }
  ): Promise<T | null> => {
    const parse = (text: string): T | null => {
      const document = parseJsonDocument(text)
      if (!document.ok) return null
      const parsed = parser.safeParse(document.value)
      return parsed.success ? parsed.data : null
    }
    const first = await call(role, deploymentId, logicalStepId, messages, {
      ...options,
      jsonSchema: schema,
    })
    const value = parse(first.text)
    if (value !== null || formatRepairs >= limits.maxFormatRepairs) return value
    formatRepairs++
    const repaired = await call(
      role,
      deploymentId,
      `${logicalStepId}:format_repair`,
      [
        ...messages,
        { role: "assistant", content: first.text.length > 0 ? first.text : "(empty)" },
        { role: "user", content: FORMAT_REPAIR_INSTRUCTION },
      ],
      { reserve: options.reserve, maxOutputTokens: options.maxOutputTokens, jsonSchema: schema }
    )
    return parse(repaired.text)
  }

  // ── PANEL_PARALLEL ──
  const memberTools =
    input.memberToolPolicyId && ports.tools
      ? ports.tools
          .describe(input.memberToolPolicyId)
          .filter((tool) => tool.toolClass === "read_only")
      : []
  const evidenceMaterial =
    input.commonEvidence.length > 0
      ? [untrustedBlock("the common evidence", commonEvidenceText)]
      : []

  const runMember = async (member: PanelMember, index: number): Promise<MemberResult> => {
    const candidateId = uuidFromName(`${input.runId}\u0000candidate\u0000${member.role}`)
    const firstStep = `panel:member:${member.role}:1`
    const messages = roleMessages("panel_member", {
      contract,
      material: evidenceMaterial,
      runtimeNote: [
        `candidate_id: ${candidateId}`,
        "You are one of several independent candidates and cannot see the others.",
        memberTools.length > 0
          ? `You may request the read-only tools offered, in one round of at most ${limits.memberToolCalls} calls; then answer.`
          : "No tools are available for this task.",
      ].join("\n"),
    })
    try {
      const first = await call(member.role, member.deploymentId, firstStep, messages, {
        reserve: memberReserve[index],
        stageId: fromStage(PANEL_MEMBER_STAGE, memberReserve[index]),
        maxOutputTokens: memberOut,
        jsonSchema: CANDIDATE_OUTPUT_SCHEMA,
        tools: memberTools,
        toolPolicyId: memberTools.length > 0 ? input.memberToolPolicyId : null,
      })
      let text = first.text
      if (first.finishReason === "tool_calls" && first.toolCalls && first.toolCalls.length > 0) {
        const receipts: ToolReceipt[] = []
        for (const [position, intent] of first.toolCalls.entries()) {
          if (!ports.tools || !input.memberToolPolicyId || memberTools.length === 0) {
            receipts.push(refusedReceipt(intent, "NO_TOOLS_OFFERED"))
          } else if (position >= limits.memberToolCalls) {
            receipts.push(refusedReceipt(intent, "TOOL_CALL_LIMIT"))
          } else {
            receipts.push(
              await ports.tools.execute(intent, {
                runId: input.runId,
                logicalStepId: firstStep,
                policyId: input.memberToolPolicyId,
                role: member.role,
                signal: input.signal,
              })
            )
          }
        }
        await ports.events.emit({
          type: "phase.changed",
          payload: {
            phase: "panel",
            step: "member_tools",
            role: member.role,
            tools: receipts.map((receipt) => ({
              name: receipt.name,
              status: receipt.status,
              ...(receipt.refusalCode ? { refusal: receipt.refusalCode } : {}),
              operation_id: receipt.operationId,
            })),
          },
        })
        let transcript: Message[] = [
          ...messages,
          {
            role: "assistant",
            content: `Requested tools: ${first.toolCalls.map((intent) => intent.name).join(", ")}`,
          },
          {
            role: "user",
            content: [
              untrustedBlock("the tool results", receiptText(receipts)),
              "The tool round is over and no further tools are available. Answer now with the candidate JSON.",
            ].join("\n\n"),
          },
        ]
        const decision = compactionDecision({
          transcriptTokens: transcriptTokens(transcript) + memberOut,
          contextLimit: member.contextLimit,
          pendingToolCalls: 0,
        })
        if (decision.compact) {
          const summaryTokens = Math.min(memberOut, 2_048)
          transcript = (
            await compactTranscript(ports, {
              runId: input.runId,
              logicalStepId: `panel:member:${member.role}`,
              deploymentId: member.deploymentId,
              reserveMicrousd: input.reserveFor(
                "compactor",
                member.deploymentId,
                OVERHEAD_TOKENS + transcriptTokens(transcript),
                summaryTokens
              ),
              transportAttempts: limits.transportAttempts,
              deadlineAt: input.deadlineAt,
              signal: input.signal,
              taskState: {
                goal: contract,
                constraints: input.messages
                  .filter((m) => m.role === "system")
                  .map((m) => m.content),
                revision: null,
              },
              transcript,
              epoch: 0,
              maxOutputTokens: summaryTokens,
            })
          ).messages
        }
        const second = await call(
          member.role,
          member.deploymentId,
          `panel:member:${member.role}:2`,
          transcript,
          {
            // Sized for what this call actually carries: the tool results too.
            reserve: input.reserveFor(
              member.role,
              member.deploymentId,
              transcriptTokens(transcript),
              memberOut
            ),
            maxOutputTokens: memberOut,
            jsonSchema: CANDIDATE_OUTPUT_SCHEMA,
          }
        )
        if (second.finishReason === "tool_calls") {
          return { status: "failed", member, candidateId, reason: "TOOL_ROUND_EXCEEDED" }
        }
        text = second.text
      }
      const document = parseJsonDocument(text)
      const parsed = document.ok ? CandidateOutput.safeParse(document.value) : null
      if (!parsed?.success)
        return { status: "failed", member, candidateId, reason: "CANDIDATE_INVALID" }

      let rejectedEvidence = 0
      const usedIds = new Set<string>()
      const claims: Claim[] = []
      for (const claim of parsed.data.claims) {
        let claimId = claim.claim_id
        for (let n = 2; usedIds.has(claimId); n++) claimId = `${claim.claim_id}-${n}`
        usedIds.add(claimId)
        const verdict = await checkEvidenceRefs(claim.evidence_refs, ports.evidence)
        rejectedEvidence += verdict.rejected.length
        claims.push({ claim_id: claimId, text: claim.text, evidence_refs: verdict.valid })
      }
      if (rejectedEvidence > 0) {
        await ports.events.emit({
          type: "candidate.rejected",
          payload: { role: member.role, scope: "evidence", rejected_refs: rejectedEvidence },
        })
      }
      const candidate = {
        schema_version: CONTRACT_SCHEMA_VERSION,
        candidate_id: candidateId,
        answer: parsed.data.answer,
        claims,
        assumptions: parsed.data.assumptions,
        open_questions: parsed.data.open_questions,
      }
      const stored = await ports.artifacts.put(
        JSON.stringify(candidate),
        "application/json",
        `runs/${input.runId}/panel/${member.role}`
      )
      return {
        status: "valid",
        candidate: {
          member,
          candidateId,
          answer: candidate.answer,
          claims,
          assumptions: candidate.assumptions,
          openQuestions: candidate.open_questions,
          artifactId: stored.artifactId,
          rejectedEvidence,
        },
      }
    } catch (error) {
      if (isFatal(error)) throw error
      const code = error instanceof WorkflowError ? error.code : "INTERNAL"
      return { status: "failed", member, candidateId, reason: code }
    }
  }

  await ports.events.emit({
    type: "phase.changed",
    payload: { phase: "panel", step: "candidates" },
  })
  const settled = await Promise.allSettled(members.map((member, index) => runMember(member, index)))
  const fatal = settled.find((entry) => entry.status === "rejected")
  if (fatal && fatal.status === "rejected") throw fatal.reason
  const results = settled.map((entry) => (entry as PromiseFulfilledResult<MemberResult>).value)
  const failed = results.filter(
    (r): r is Extract<MemberResult, { status: "failed" }> => r.status === "failed"
  )
  const validRaw = results.filter(
    (r): r is Extract<MemberResult, { status: "valid" }> => r.status === "valid"
  )
  for (const failure of failed) {
    await ports.events.emit({
      type: "candidate.rejected",
      payload: { role: failure.member.role, scope: "candidate", reason: failure.reason },
    })
  }

  // The judge sees candidates anonymously, in an order the run seed fixes.
  const ordered = seededOrder(validRaw, seed).map((entry, position): ValidCandidate => {
    const label = LABELS[position]
    return {
      ...entry.candidate,
      label,
      claims: entry.candidate.claims.map((claim) => ({
        ...claim,
        globalId: `${label}.${claim.claim_id}`,
        candidateLabel: label,
      })),
    }
  })
  const candidateOutcomes: PanelCandidateOutcome[] = [
    ...ordered.map((c) => ({
      role: c.member.role,
      label: c.label,
      status: "valid" as const,
      reason: null,
      candidateId: c.candidateId,
      artifactId: c.artifactId,
      rejectedEvidence: c.rejectedEvidence,
    })),
    ...failed.map((f) => ({
      role: f.member.role,
      label: null,
      status: "failed" as const,
      reason: f.reason,
      candidateId: f.candidateId,
      artifactId: null,
      rejectedEvidence: 0,
    })),
  ]
  const partial = failed.length > 0

  if (ordered.length < limits.minCandidates) {
    await ports.ledger.releaseStage(PANEL_TAIL_STAGE)
    await ports.ledger.releaseStage(PANEL_MEMBER_STAGE)
    if (ordered.length === 1 && input.allowDegraded) {
      return degradedSingle(ports, input, ordered[0], candidateOutcomes, memberOut)
    }
    throw new WorkflowError(
      "FUSION_INSUFFICIENT_CANDIDATES",
      `the panel needs ${limits.minCandidates} valid candidates and has ${ordered.length}`,
      { valid: ordered.length, required: limits.minCandidates, failed: failed.map((f) => f.reason) }
    )
  }

  // ── JUDGE ──
  const claimsById = new Map<string, ValidatedClaim>()
  for (const candidate of ordered)
    for (const claim of candidate.claims) claimsById.set(claim.globalId, claim)
  const evidenceIndex = await buildEvidenceIndex(ports, ordered, input.commonEvidence)
  const anonymous = ordered.map((candidate) => ({
    label: candidate.label,
    answer: candidate.answer,
    claims: candidate.claims.map((claim) => ({
      id: claim.globalId,
      text: claim.text,
      evidence: claim.evidence_refs.map((ref) => ({
        artifact_id: ref.artifact_id,
        locator: ref.locator,
      })),
    })),
    assumptions: candidate.assumptions,
    open_questions: candidate.openQuestions,
  }))
  const judgeMaterial = [
    untrustedBlock("the anonymous candidates", JSON.stringify(anonymous, null, 2)),
    untrustedBlock("the evidence index", evidenceIndex),
    "Refer to claims by their `id`. Every claim id above is already namespaced by its candidate.",
  ]
  const judgeMessages = roleMessages("judge", {
    contract,
    material: judgeMaterial,
    ...(input.profile === "evidence_review"
      ? {
          runtimeNote:
            "Acceptance profile evidence_review: a claim is supported only by evidence of its own; candidates agreeing is not evidence.",
        }
      : {}),
  })
  await ports.events.emit({
    type: "phase.changed",
    payload: { phase: "judge", candidates: ordered.length },
  })
  const firstReport = await callForJson(
    "judge",
    input.judge.deploymentId,
    "panel:judge:1",
    judgeMessages,
    JUDGE_OUTPUT_SCHEMA,
    JudgeOutput,
    {
      reserve: judgeReserve,
      stageId: fromStage(PANEL_TAIL_STAGE, judgeReserve),
      maxOutputTokens: input.outputTokens.judge,
    }
  )
  if (!firstReport) {
    await ports.ledger.releaseStage(PANEL_TAIL_STAGE)
    throw new WorkflowError(
      "JUDGE_OUTPUT_INVALID",
      "the judge's report stayed invalid; no review is invented"
    )
  }
  let rawReport: JudgeOutputValue = firstReport

  // ── VERIFY_EVIDENCE → REJUDGE (bounded) ──
  let round = 0
  while (rawReport.verification_requests.length > 0 && round < limits.evidenceRounds) {
    round++
    const requests = rawReport.verification_requests.slice(0, limits.verificationRequests)
    const receipts = await runVerificationRequests(ports, input, requests, round)
    await ports.events.emit({
      type: "verification.requested",
      payload: {
        round,
        requests: requests.map((request, i) => ({
          request_id: request.request_id,
          kind: request.kind,
          status: receipts[i].status,
          ...(receipts[i].refusalCode ? { refusal: receipts[i].refusalCode } : {}),
        })),
        ignored: rawReport.verification_requests.length - requests.length,
      },
    })
    const rejudged: JudgeOutputValue | null = await callForJson(
      "judge",
      input.judge.deploymentId,
      `panel:judge:${round + 1}`,
      [
        ...judgeMessages,
        {
          role: "assistant",
          content: JSON.stringify({ ...rawReport, verification_requests: requests }),
        },
        {
          role: "user",
          content: [
            untrustedBlock("the verification results", receiptText(receipts)),
            "Re-judge with these results. This is the last verification round; do not request more.",
          ].join("\n\n"),
        },
      ],
      JUDGE_OUTPUT_SCHEMA,
      JudgeOutput,
      { reserve: judgeReserve, maxOutputTokens: input.outputTokens.judge }
    )
    if (!rejudged) {
      // A rejudge that stayed invalid does not erase the first review; the
      // requests it raised stay open, which the synthesis must state.
      break
    }
    rawReport = rejudged
  }
  if (rawReport.verification_requests.length > 0) {
    await ports.events.emit({
      type: "phase.changed",
      payload: {
        phase: "judge",
        step: "verification_requests_left_open",
        count: rawReport.verification_requests.length,
        rounds_used: round,
      },
    })
  }

  // Sanitise: unknown ids are dropped, a rejection beats a support, and under
  // evidence_review a support without evidence of its own does not count.
  const known = (id: string) => claimsById.has(id)
  const rejected = new Set(rawReport.rejected_claim_ids.filter(known))
  let supported = [...new Set(rawReport.supported_claim_ids.filter(known))].filter(
    (id) => !rejected.has(id)
  )
  const unverified =
    input.profile === "evidence_review"
      ? supported.filter((id) => (claimsById.get(id)?.evidence_refs.length ?? 0) === 0)
      : []
  supported = supported.filter((id) => !unverified.includes(id))
  const contradictions: Contradiction[] = []
  for (const contradiction of rawReport.contradictions) {
    const verdict = await checkEvidenceRefs(contradiction.evidence_refs, ports.evidence)
    const ids = contradiction.claim_ids.filter(known)
    if (ids.length === 0) continue
    contradictions.push({ ...contradiction, claim_ids: ids, evidence_refs: verdict.valid })
  }
  const judgeReport: JudgeReport = {
    schema_version: CONTRACT_SCHEMA_VERSION,
    supported_claim_ids: supported,
    rejected_claim_ids: [...rejected],
    contradictions,
    missing_requirements: rawReport.missing_requirements,
    // Only ids that can name an artifact survive into the report.
    verification_requests: rawReport.verification_requests.map((request): VerificationRequest => ({
      ...request,
      artifact_ids: request.artifact_ids.filter((id) => UUID.test(id)),
    })),
    ready_to_synthesize: rawReport.ready_to_synthesize,
  }
  const judgeArtifact = await ports.artifacts.put(
    JSON.stringify(judgeReport),
    "application/json",
    `runs/${input.runId}/panel/judge`
  )
  await ports.events.emit({
    type: "phase.changed",
    payload: {
      phase: "judge",
      step: "reported",
      supported: supported.length,
      rejected: rejected.size,
      unverified: unverified.length,
      contradictions: contradictions.length,
      unresolved: contradictions.filter((c) => c.resolution === "unresolved").length,
      report_artifact_id: judgeArtifact.artifactId,
    },
  })

  // ── SYNTHESIZE ──
  const supportedSet = new Set(supported)
  const approved = supported.map((id) => {
    const claim = claimsById.get(id)!
    return {
      id,
      text: claim.text,
      evidence: claim.evidence_refs.map((ref) => ({
        artifact_id: ref.artifact_id,
        locator: ref.locator,
      })),
    }
  })
  const barred = [...claimsById.values()]
    .filter((claim) => !supportedSet.has(claim.globalId))
    .map((claim) => ({ id: claim.globalId, text: claim.text }))
  const synthesisMessages = roleMessages("synthesizer", {
    contract,
    material: [
      untrustedBlock("the approved claims", JSON.stringify(approved, null, 2)),
      untrustedBlock(
        "the judge report",
        JSON.stringify(
          {
            unresolved_contradictions: contradictions.filter((c) => c.resolution === "unresolved"),
            missing_requirements: judgeReport.missing_requirements,
            open_verification_requests: judgeReport.verification_requests.map((r) => r.question),
          },
          null,
          2
        )
      ),
      untrustedBlock(
        "claims that are NOT approved and must not be stated as fact",
        JSON.stringify(barred, null, 2)
      ),
      [
        "Output requirements:",
        "- state as fact only approved claims, and list every claim id you rely on in used_claim_ids;",
        "- cite evidence only by an artifact_id listed with the claim it supports;",
        "- state unresolved contradictions, missing requirements and open questions as uncertainties.",
        ...(input.jsonSchema
          ? [
              `- the answer field must itself be a JSON document matching this schema: ${JSON.stringify(input.jsonSchema)}`,
            ]
          : []),
      ].join("\n"),
    ],
    ...(partial
      ? { runtimeNote: "Runtime note: one panel member failed; this is a partial panel." }
      : {}),
  })
  await ports.events.emit({ type: "phase.changed", payload: { phase: "synthesis" } })
  const synthesis = await callForJson(
    "synthesizer",
    input.synthesizer.deploymentId,
    "panel:synthesis",
    synthesisMessages,
    SYNTHESIS_OUTPUT_SCHEMA,
    SynthesisOutput,
    {
      reserve: synthReserve,
      stageId: fromStage(PANEL_TAIL_STAGE, synthReserve),
      maxOutputTokens: input.outputTokens.synthesizer,
    }
  )
  if (!synthesis) {
    await ports.ledger.releaseStage(PANEL_TAIL_STAGE)
    throw new WorkflowError(
      "FORMAT_INVALID",
      "the synthesis stayed invalid after the allowed repair"
    )
  }

  // ── FINAL_VERIFY ──
  await ports.events.emit({ type: "phase.changed", payload: { phase: "verification" } })
  const reportId = ports.newId()
  const checks: VerificationCheck[] = []
  checks.push(
    checkOf(
      "non_empty",
      "format",
      synthesis.answer.trim().length > 0 ? "passed" : "failed",
      "the answer is not empty"
    )
  )
  const leaning = synthesis.used_claim_ids.filter((id) => !supportedSet.has(id))
  checks.push(
    checkOf(
      "claims_supported",
      "evidence",
      leaning.length === 0 ? "passed" : "failed",
      leaning.length === 0
        ? `relies on ${synthesis.used_claim_ids.length} approved claim(s) only`
        : `relies on claims the judge did not approve: ${leaning.join(", ")}`
    )
  )
  const citable = new Map<string, Set<string>>()
  for (const id of synthesis.used_claim_ids) {
    const claim = claimsById.get(id)
    if (claim && supportedSet.has(id))
      citable.set(id, new Set(claim.evidence_refs.map((r) => r.artifact_id)))
  }
  const forged = synthesis.citations.filter((c) => !citable.get(c.claim_id)?.has(c.artifact_id))
  const citedArtifacts = [...new Set(synthesis.citations.map((c) => c.artifact_id))]
  checks.push(
    checkOf(
      "citations",
      "evidence",
      forged.length === 0 ? "passed" : "failed",
      forged.length === 0
        ? `${synthesis.citations.length} citation(s), each backed by its claim's evidence`
        : `citations not backed by an approved claim's evidence: ${forged.map((c) => `${c.claim_id}→${c.artifact_id}`).join(", ")}`,
      "runtime",
      forged.length === 0 ? citedArtifacts : []
    )
  )
  if (input.jsonSchema) {
    const shaped = verifySchemaFixture({
      reportId,
      text: synthesis.answer,
      schema: input.jsonSchema,
    })
    checks.push(
      checkOf("answer_schema", "format", shaped.status, "the answer matches the requested schema")
    )
  }
  if (
    input.profile === "evidence_review" &&
    supported.length === 0 &&
    synthesis.used_claim_ids.length === 0
  ) {
    checks.push(
      checkOf(
        "evidence_present",
        "evidence",
        "inconclusive",
        "no claim was supported by evidence; the answer states uncertainty only"
      )
    )
  }

  if (aggregate(checks) !== "failed") {
    const review = await callForJson(
      "judge",
      input.judge.deploymentId,
      "panel:final_check",
      roleMessages("judge", {
        contract,
        material: [
          untrustedBlock("the approved claims", JSON.stringify(approved, null, 2)),
          untrustedBlock("the synthesized answer", synthesis.answer),
          [
            "Final check of the synthesis, not a new review of the candidates:",
            "- list every factual statement in the answer that no approved claim supports (new_unsupported_claims);",
            "- list requirements of the task the answer misses, and citations it dropped;",
            "- status failed if any statement is new and unsupported, inconclusive if you cannot tell.",
          ].join("\n"),
        ],
      }),
      FINAL_CHECK_OUTPUT_SCHEMA,
      FinalCheckOutput,
      {
        reserve: finalReserve,
        stageId: fromStage(PANEL_TAIL_STAGE, finalReserve),
        maxOutputTokens: input.outputTokens.finalCheck,
      }
    )
    if (!review) {
      checks.push(
        checkOf("final_review", "review", "inconclusive", "the final review was not valid", "model")
      )
    } else {
      const status: VerificationCheck["status"] =
        review.new_unsupported_claims.length > 0 ? "failed" : review.status
      const notes = [
        ...review.new_unsupported_claims.map((c) => `unsupported: ${c}`),
        ...review.missing_requirements.map((c) => `missing: ${c}`),
        ...review.lost_citations.map((c) => `lost citation: ${c}`),
      ]
      checks.push(
        checkOf(
          "final_review",
          "review",
          status,
          notes.length > 0 ? notes.slice(0, 8).join("; ") : "no new unsupported claims",
          "model"
        )
      )
    }
  }
  await ports.ledger.releaseStage(PANEL_TAIL_STAGE)

  const status = aggregate(checks)
  const verification: VerificationReport = {
    schema_version: CONTRACT_SCHEMA_VERSION,
    report_id: reportId,
    status,
    level: "mixed",
    checks,
    revision: null,
    verifier_version: PANEL_VERIFIER_VERSION,
    artifact_refs: [judgeArtifact.artifactId],
  }
  await ports.events.emit({
    type: "verification.completed",
    payload: { status, level: verification.level, report_id: reportId },
  })
  if (status !== "passed" && !input.allowDegraded) {
    throw new WorkflowError(
      status === "failed" ? "VERIFICATION_FAILED" : "VERIFICATION_INCONCLUSIVE",
      status === "failed"
        ? "the synthesis failed its final verification"
        : "the synthesis could not be verified, and the request did not allow a degraded result",
      { report_id: reportId, unsupported_claim_ids: leaning }
    )
  }

  const answerArtifact = await ports.artifacts.put(
    synthesis.answer,
    input.jsonSchema ? "application/json" : "text/markdown",
    `runs/${input.runId}/answer`
  )
  const degraded = status !== "passed"
  const quality = acceptanceClaimFor({
    verificationStatus: status,
    profile: input.profile,
    task: input.task,
    deliversChange: input.deliversChange,
    degraded,
  })
  const result: RunResult = {
    answer: synthesis.answer,
    answer_artifact_id: answerArtifact.artifactId,
    answer_sha256: sha256Hex(synthesis.answer),
    mode_executed: "panel",
    quality_status: quality,
    verification,
    delivery: "answer",
    artifact_ids: [
      answerArtifact.artifactId,
      ...ordered.map((c) => c.artifactId),
      judgeArtifact.artifactId,
    ],
    warnings: [
      ...(partial ? ["panel_partial"] : []),
      ...(plan.adjusted ? ["candidate_output_bound_lowered"] : []),
      ...(unverified.length > 0 ? ["claims_without_evidence_not_supported"] : []),
      ...(judgeReport.verification_requests.length > 0 ? ["verification_requests_left_open"] : []),
      ...(synthesis.uncertainties.length > 0 ? ["answer_states_uncertainty"] : []),
      ...(degraded ? [`final_verification_${status}`] : []),
      ...(formatRepairs > 0 ? ["format_repaired"] : []),
    ],
  }
  return {
    result,
    partial,
    degradedToSingle: false,
    candidates: candidateOutcomes,
    judgeReport,
    supportedClaimIds: supported,
    unverifiedClaimIds: unverified,
    formatRepairs,
    memberOutputTokens: memberOut,
  }
}

async function buildEvidenceIndex(
  ports: PanelRunPorts,
  candidates: readonly ValidCandidate[],
  common: PanelRunInput["commonEvidence"]
): Promise<string> {
  const seen = new Map<string, EvidenceRef>()
  for (const entry of common) seen.set(entry.ref.artifact_id, entry.ref)
  for (const candidate of candidates) {
    for (const claim of candidate.claims)
      for (const ref of claim.evidence_refs) seen.set(ref.artifact_id, ref)
  }
  const lines: string[] = []
  for (const ref of seen.values()) {
    const stored = await ports.artifacts.get(ref.artifact_id)
    const excerpt = stored
      ? stored.content.slice(0, EVIDENCE_EXCERPT_CHARS)
      : "(content unavailable)"
    const truncated =
      stored && stored.content.length > EVIDENCE_EXCERPT_CHARS
        ? " [truncated; full artifact by id]"
        : ""
    lines.push(
      `${ref.artifact_id} ${ref.locator} sha256=${ref.content_sha256}${truncated}\n${excerpt}`
    )
  }
  return lines.length > 0 ? lines.join("\n\n") : "(no evidence was cited)"
}

async function runVerificationRequests(
  ports: PanelRunPorts,
  input: PanelRunInput,
  requests: ReadonlyArray<JudgeOutputValue["verification_requests"][number]>,
  round: number
): Promise<ToolReceipt[]> {
  const receipts: ToolReceipt[] = []
  for (const request of requests) {
    const intent: ToolIntent = {
      id: `verify:${round}:${request.request_id}`,
      name: request.kind,
      arguments: { artifact_ids: request.artifact_ids, question: request.question },
    }
    if (!ports.tools || !input.verificationToolPolicyId) {
      receipts.push(refusedReceipt(intent, "VERIFICATION_TOOLS_UNAVAILABLE"))
      continue
    }
    // `compute` and `test` need a sandbox a panel does not have; the runtime's
    // policy decides, and a policy without them refuses them.
    receipts.push(
      await ports.tools.execute(intent, {
        runId: input.runId,
        logicalStepId: `panel:verify:${round}`,
        policyId: input.verificationToolPolicyId,
        role: "judge",
        signal: input.signal,
      })
    )
  }
  return receipts
}

async function degradedSingle(
  ports: PanelRunPorts,
  input: PanelRunInput,
  candidate: ValidCandidate,
  candidates: PanelCandidateOutcome[],
  memberOutputTokens: number
): Promise<PanelRunOutcome> {
  const reportId = ports.newId()
  const basic = verifyTextBasic({ reportId, text: candidate.answer })
  const verification: VerificationReport = {
    ...basic,
    verifier_version: `${TEXT_VERIFIER_VERSION}+single-candidate`,
    checks: [
      ...basic.checks,
      {
        check_id: "panel_review",
        kind: "review",
        status: "not_applicable",
        summary: "only one candidate was valid: no panel review took place",
        executed_by: "runtime",
        artifact_refs: [],
      },
    ],
  }
  await ports.events.emit({
    type: "run.degraded",
    payload: {
      reason: "FUSION_INSUFFICIENT_CANDIDATES",
      mode_executed: "direct",
      report_id: reportId,
    },
  })
  const answerArtifact = await ports.artifacts.put(
    candidate.answer,
    "text/markdown",
    `runs/${input.runId}/answer`
  )
  const result: RunResult = {
    answer: candidate.answer,
    answer_artifact_id: answerArtifact.artifactId,
    answer_sha256: sha256Hex(candidate.answer),
    // A single candidate is not a fusion result, whatever mode was asked for.
    mode_executed: "direct",
    quality_status: acceptanceClaimFor({
      verificationStatus: verification.status,
      profile: "text_basic",
      task: input.task,
      deliversChange: input.deliversChange,
      degraded: true,
    }),
    verification,
    delivery: "answer",
    artifact_ids: [answerArtifact.artifactId, candidate.artifactId],
    warnings: ["panel_insufficient_candidates", "single_candidate_unreviewed"],
  }
  return {
    result,
    partial: true,
    degradedToSingle: true,
    candidates,
    judgeReport: null,
    supportedClaimIds: [],
    unverifiedClaimIds: [],
    formatRepairs: 0,
    memberOutputTokens,
  }
}
