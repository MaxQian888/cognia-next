/**
 * Direct workflow (DESIGN §8): CONTEXT → INVOKE → [FORMAT_REPAIR] → VERIFY → FINALIZE.
 *
 * One solver, at most one global format repair, verification against the
 * resolved acceptance profile, and a result that claims only what its checks
 * proved. A semantic verification failure never quietly swaps in a stronger
 * model; that is a new decision, not a retry. Chat turns stream deltas live
 * (ADR-0188 D7) — a replaced draft after a format repair is announced with
 * `answer.replaced` so the host can label it.
 *
 * Host wiring: in B1 no host runs this graph. A chat turn is a direct run whose
 * INVOKE step is the sidecar's own model loop, ledgered call by call through
 * `lib/router-fusion/chat/chat-runs.ts`, with the `text_basic` schema-only
 * acceptance; the conversation, tools and streaming stay the sidecar's. The
 * first host of `runDirect` is the Run API (B2), where Router + Fusion owns the
 * whole run. `direct.test.ts` pins the graph against the Fake Provider.
 */

import type { ExecutionMode, Message, RunResult, TaskKind } from "../contracts/schemas"
import type { VerifierProfile } from "../config/types"
import { acceptanceClaimFor } from "../verify/profiles"
import {
  parseJsonDocument,
  verifySchemaFixture,
  type TextBasicRules,
} from "../verify/text-verifiers"
import { sha256Hex } from "../util/sha256"
import { verifyAnswer, type AnswerVerifierPorts } from "./answer-verifier"
import { WorkflowError, performDurableCall } from "./durable-call"
import type { ArtifactStore } from "./ports"

export interface DirectRunPorts extends AnswerVerifierPorts {
  artifacts: ArtifactStore
}

export interface DirectRunInput {
  runId: string
  deploymentId: string
  reviewerDeploymentId?: string
  messages: Message[]
  maxOutputTokens: number
  reserveMicrousd: number
  transportAttempts: number
  maxFormatRepairs: number
  deadlineAt: number
  profile: VerifierProfile
  task: TaskKind
  deliversChange: boolean
  jsonSchema?: Record<string, unknown>
  textRules?: TextBasicRules
  fixtureExpectations?: Record<string, unknown>
  toolPolicyId: string | null
  stream: boolean
  signal: AbortSignal
  onDelta?: (text: string) => void
}

export interface DirectRunOutcome {
  result: RunResult
  formatRepairs: number
}

export function formatValid(text: string, schema: Record<string, unknown> | undefined): boolean {
  if (!schema) return true
  const parsed = parseJsonDocument(text)
  if (!parsed.ok) return false
  return verifySchemaFixture({ reportId: "format", text, schema }).status === "passed"
}

export async function runDirect(
  ports: DirectRunPorts,
  input: DirectRunInput
): Promise<DirectRunOutcome> {
  const emitDelta = (text: string) => {
    input.onDelta?.(text)
  }
  const solve = async (messages: Message[], stepId: string, stream: boolean) =>
    performDurableCall(ports, {
      runId: input.runId,
      logicalStepId: stepId,
      role: "solver",
      deploymentId: input.deploymentId,
      reserveMicrousd: input.reserveMicrousd,
      transportAttempts: input.transportAttempts,
      deadlineAt: input.deadlineAt,
      signal: input.signal,
      request: {
        messages,
        maxOutputTokens: input.maxOutputTokens,
        jsonSchema: input.jsonSchema,
        toolPolicyId: input.toolPolicyId,
        ...(stream ? { onDelta: emitDelta } : {}),
      },
    })

  await ports.events.emit({
    type: "phase.changed",
    payload: { phase: "execution", step: "invoke" },
  })
  let answer = await solve(input.messages, "direct:solver", input.stream)
  let text = answer.text
  let formatRepairs = 0

  while (!formatValid(text, input.jsonSchema)) {
    if (formatRepairs >= input.maxFormatRepairs) {
      throw new WorkflowError(
        "FORMAT_INVALID",
        "the structured output stayed invalid after the allowed repair"
      )
    }
    formatRepairs++
    await ports.events.emit({
      type: "phase.changed",
      payload: { phase: "execution", step: "format_repair", attempt: formatRepairs },
    })
    const repairMessages: Message[] = [
      ...input.messages,
      { role: "assistant", content: text.length > 0 ? text : "(empty)" },
      {
        role: "user",
        content:
          "The previous answer did not match the required JSON schema. Return only a JSON document that matches the schema; change nothing else.",
      },
    ]
    answer = await solve(repairMessages, `direct:format_repair:${formatRepairs}`, false)
    text = answer.text
    if (input.stream) {
      await ports.events.emit({
        type: "phase.changed",
        payload: { phase: "execution", step: "answer.replaced", reason: "format_repair" },
      })
    }
  }

  await ports.events.emit({ type: "phase.changed", payload: { phase: "verification" } })
  const verification = await verifyAnswer(ports, {
    runId: input.runId,
    stepPrefix: "direct",
    profile: input.profile,
    text,
    messages: input.messages,
    ...(input.jsonSchema ? { jsonSchema: input.jsonSchema } : {}),
    ...(input.textRules ? { textRules: input.textRules } : {}),
    ...(input.fixtureExpectations ? { fixtureExpectations: input.fixtureExpectations } : {}),
    reviewerDeploymentId: input.reviewerDeploymentId ?? input.deploymentId,
    reserveMicrousd: input.reserveMicrousd,
    transportAttempts: input.transportAttempts,
    deadlineAt: input.deadlineAt,
    signal: input.signal,
  })
  await ports.events.emit({
    type: "verification.completed",
    payload: {
      status: verification.status,
      level: verification.level,
      report_id: verification.report_id,
    },
  })

  const quality = acceptanceClaimFor({
    verificationStatus: verification.status,
    profile: input.profile,
    task: input.task,
    deliversChange: input.deliversChange,
    degraded: false,
  })
  const stored = await ports.artifacts.put(
    text,
    input.jsonSchema ? "application/json" : "text/markdown",
    `runs/${input.runId}/answer`
  )
  const mode: ExecutionMode = "direct"
  const result: RunResult = {
    answer: text,
    answer_artifact_id: stored.artifactId,
    answer_sha256: sha256Hex(text),
    mode_executed: mode,
    quality_status: quality,
    verification,
    delivery: "answer",
    artifact_ids: [stored.artifactId],
    warnings: [
      ...(formatRepairs > 0 ? ["format_repaired"] : []),
      ...(verification.level === "schema_only" ? ["verified_format_only"] : []),
    ],
  }
  return { result, formatRepairs }
}
