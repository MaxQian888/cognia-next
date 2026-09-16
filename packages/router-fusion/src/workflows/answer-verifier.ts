/**
 * Verify one answer against the run's acceptance profile (DESIGN §8, §25.3).
 *
 * Shared by direct and by each cascade stage, so both claim exactly what their
 * checks proved and nothing more:
 *
 * - `text_basic` — format only (`schema_only`);
 * - `schema_fixture` — a JSON Schema check plus fixture expectations, and
 *   `inconclusive` when there is no schema to check against;
 * - `text_review` — the format checks, then one billed reviewer call whose
 *   verdict counts only when it is itself valid;
 * - `code_fixture` — a runtime verifier the host supplies (a sandboxed test
 *   run, B4); with none, `inconclusive`, never a pass;
 * - `evidence_review` — the panel's own final check; any other mode asking for
 *   it gets `inconclusive`.
 */

import type { Message, VerificationReport } from "../contracts/schemas"
import type { VerifierProfile } from "../config/types"
import {
  parseJsonDocument,
  verifySchemaFixture,
  verifyTextBasic,
  type TextBasicRules,
} from "../verify/text-verifiers"
import { performDurableCall, type DurableCallPorts } from "./durable-call"
import { roleMessages, taskContract, untrustedBlock } from "./prompting"

/** A tool-backed verifier for profiles a model cannot satisfy (code_fixture). */
export interface RuntimeVerifier {
  verify(input: {
    runId: string
    profile: VerifierProfile
    text: string
  }): Promise<VerificationReport>
}

export interface AnswerVerifierPorts extends DurableCallPorts {
  newId: () => string
  runtimeVerifier?: RuntimeVerifier
}

export interface AnswerVerificationInput {
  runId: string
  /** Logical step prefix; the reviewer call is `<prefix>:reviewer`. */
  stepPrefix: string
  profile: VerifierProfile
  text: string
  messages: Message[]
  jsonSchema?: Record<string, unknown>
  textRules?: TextBasicRules
  fixtureExpectations?: Record<string, unknown>
  reviewerDeploymentId: string
  reserveMicrousd: number
  transportAttempts: number
  deadlineAt: number
  signal: AbortSignal
}

export const REVIEW_SCHEMA = {
  type: "object",
  required: ["status", "issues"],
  properties: {
    status: { type: "string", enum: ["passed", "failed", "inconclusive"] },
    issues: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
} as const

const REVIEW_OUTPUT_TOKENS = 1024

export async function verifyAnswer(
  ports: AnswerVerifierPorts,
  input: AnswerVerificationInput
): Promise<VerificationReport> {
  const reportId = ports.newId()
  const { text } = input
  switch (input.profile) {
    case "text_basic":
      return verifyTextBasic({
        reportId,
        text,
        rules: { ...input.textRules, expectJson: Boolean(input.jsonSchema) },
      })
    case "schema_fixture":
      if (!input.jsonSchema) {
        return {
          ...verifyTextBasic({ reportId, text }),
          status: "inconclusive",
          level: "tool_verified",
        }
      }
      return verifySchemaFixture({
        reportId,
        text,
        schema: input.jsonSchema,
        expectedFields: input.fixtureExpectations,
      })
    case "text_review":
      return reviewByModel(ports, input, reportId)
    case "code_fixture":
      if (!ports.runtimeVerifier) {
        return {
          ...verifyTextBasic({ reportId, text }),
          status: "inconclusive",
          level: "tool_verified",
        }
      }
      return ports.runtimeVerifier.verify({ runId: input.runId, profile: input.profile, text })
    default:
      return { ...verifyTextBasic({ reportId, text }), status: "inconclusive", level: "mixed" }
  }
}

async function reviewByModel(
  ports: AnswerVerifierPorts,
  input: AnswerVerificationInput,
  reportId: string
): Promise<VerificationReport> {
  const basic = verifyTextBasic({ reportId, text: input.text, rules: input.textRules })
  if (basic.status === "failed") return { ...basic, level: "model_review" }
  const review = await performDurableCall(ports, {
    runId: input.runId,
    logicalStepId: `${input.stepPrefix}:reviewer`,
    role: "reviewer",
    deploymentId: input.reviewerDeploymentId,
    reserveMicrousd: input.reserveMicrousd,
    transportAttempts: input.transportAttempts,
    deadlineAt: input.deadlineAt,
    signal: input.signal,
    request: {
      messages: roleMessages("reviewer", {
        contract: taskContract(input.messages),
        material: [
          untrustedBlock("the answer under review", input.text),
          untrustedBlock(
            "the runtime check results",
            basic.checks.map((check) => `${check.check_id}: ${check.status}`).join("\n")
          ),
        ],
      }),
      maxOutputTokens: REVIEW_OUTPUT_TOKENS,
      jsonSchema: REVIEW_SCHEMA,
      toolPolicyId: null,
    },
  })
  const parsed = parseJsonDocument(review.text)
  const valid =
    parsed.ok &&
    verifySchemaFixture({ reportId, text: review.text, schema: REVIEW_SCHEMA }).status === "passed"
  const verdict = valid
    ? (parsed as { ok: true; value: { status: string; issues: string[] } }).value
    : null
  const status = verdict ? (verdict.status as VerificationReport["status"]) : "inconclusive"
  return {
    ...basic,
    level: "model_review",
    status,
    checks: [
      ...basic.checks,
      {
        check_id: "model_review",
        kind: "review",
        status,
        summary: verdict
          ? verdict.issues.length
            ? verdict.issues.slice(0, 5).join("; ")
            : "no issues reported"
          : "review output was not valid",
        executed_by: "model",
        artifact_refs: [],
      },
    ],
  }
}
