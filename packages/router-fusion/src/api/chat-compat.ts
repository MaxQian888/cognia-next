/**
 * The chat-completions subset Cognia serves for its virtual router models
 * (DESIGN §15, ADR-0188 D13): the mapping between the compat shapes and a run.
 *
 * A compat call is stateless: the caller sends the whole conversation every
 * time. It becomes an ordinary run in a new conversation, with the full
 * message snapshot (system and assistant turns included) as the run's input,
 * and the same account policy a `POST /v1/runs` request is held to. Nothing in
 * the compat shape can ask for more than a run could.
 *
 * What the mapping refuses rather than guesses:
 *  - a conversation with no user turn — there is nothing to answer;
 *  - `response_format: json_schema` without the schema — a structured answer
 *    nobody can check is not a structured answer;
 *  - an auto request on a build that executes no mode the compat subset has
 *    (delegate never answers here, by design).
 */

import {
  CONTRACT_SCHEMA_VERSION,
  type BillingSummary,
  type ChatRequest,
  type ChatResponse,
  type ExecutionMode,
  type Message,
  type RunRequest,
  type RunResult,
} from "../contracts/schemas"
import { parseRunRequest, type ApiIssue, type Parsed, type RunRequestPolicy } from "./request-rules"

export const CHAT_COMPAT_ENDPOINT = "POST /v1/chat/completions"

/** `RunRequest.input_messages` holds at most this many user turns. */
export const RUN_INPUT_MESSAGE_LIMIT = 20

/** The modes a compat model can reach. `router/delegate` does not exist. */
const COMPAT_MODES: readonly ExecutionMode[] = ["direct", "cascade", "panel"]

export interface ChatRunInput {
  /** The run request the compat call stands for, validated like any other. */
  request: RunRequest
  /** The caller's whole conversation, in order. */
  messages: Message[]
  jsonSchema: Record<string, unknown> | null
}

function refusal(
  code: ApiIssue["code"],
  message: string,
  details: Record<string, unknown> = {}
): Parsed<never> {
  return { ok: false, issues: [{ status: 422, code, message, details }] }
}

/**
 * The run a parsed compat request stands for. `executableModes` is what this
 * build can run; an auto request may pick among those the compat subset has.
 */
export function chatRunInputOf(
  chat: ChatRequest,
  executableModes: readonly ExecutionMode[],
  policy: RunRequestPolicy
): Parsed<ChatRunInput> {
  const users = chat.messages.filter((message) => message.role === "user")
  if (users.length === 0) {
    return refusal("SCHEMA_INVALID", "a chat request needs at least one user message", {
      paths: ["messages"],
    })
  }
  const format = chat.response_format
  if (format?.type === "json_schema" && !format.json_schema) {
    return refusal("SCHEMA_INVALID", "response_format json_schema needs the schema itself", {
      paths: ["response_format.json_schema"],
    })
  }
  const jsonSchema = format?.type === "json_schema" ? (format.json_schema ?? null) : null

  const requested = chat.model.slice("router/".length) as "auto" | ExecutionMode
  const available = COMPAT_MODES.filter((mode) => executableModes.includes(mode))
  const allowed = requested === "auto" ? available : [requested]
  if (allowed.length === 0) {
    return refusal(
      "MODE_NOT_ALLOWED",
      "this build executes no mode the chat-compat models can reach",
      {
        mode: requested,
      }
    )
  }

  const body: RunRequest = {
    schema_version: CONTRACT_SCHEMA_VERSION,
    // The newest user turns: they are what the request is about, and all the
    // turns (the others included) travel as the run's input anyway.
    input_messages: users
      .slice(-RUN_INPUT_MESSAGE_LIMIT)
      .map((message) => ({ role: "user" as const, content: message.content })),
    mode: requested,
    allowed_modes: allowed,
    profile: chat.routing.profile,
    budget: chat.routing.budget,
    deadline_ms: chat.routing.deadline_ms,
    allow_degraded: chat.routing.allow_degraded,
    delivery: "verified_buffered",
  }
  const parsed = parseRunRequest(body, policy)
  if (!parsed.ok) return parsed
  return {
    ok: true,
    value: {
      request: parsed.value,
      messages: chat.messages.map((message) => ({ role: message.role, content: message.content })),
      jsonSchema,
    },
  }
}

export interface ChatResponseInput {
  runId: string
  /** The model name the caller asked for, echoed back as it was sent. */
  model: string
  createdAtMs: number
  result: RunResult
  billing: BillingSummary
  usage: { promptTokens: number; completionTokens: number }
}

/** The compat answer for a run that succeeded. */
export function chatResponseOf(input: ChatResponseInput): ChatResponse {
  return {
    id: `chatcmpl-${input.runId}`,
    object: "chat.completion",
    created: Math.floor(input.createdAtMs / 1000),
    model: input.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: input.result.answer },
        // A verified answer is a whole answer: one cut short fails its checks.
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: input.usage.promptTokens,
      completion_tokens: input.usage.completionTokens,
      total_tokens: input.usage.promptTokens + input.usage.completionTokens,
    },
    routing: {
      run_id: input.runId,
      mode_executed: input.result.mode_executed,
      degraded: input.result.quality_status === "degraded",
      billing: input.billing,
    },
  }
}

/** The HTTP statuses a compat call may fail with (DESIGN §15.1). */
export type ChatFailureStatus = 409 | 422 | 429 | 503

const CONFLICT_CODES = new Set([
  "RUN_BUDGET_EXHAUSTED",
  "TENANT_BUDGET_EXHAUSTED",
  "BUDGET_FROZEN",
  "MAX_MODEL_CALLS",
  "SESSION_BUSY",
  "SESSION_VERSION_CONFLICT",
  "RUN_CANCELLED",
])
const UNPROCESSABLE_CODES = new Set([
  "VERIFICATION_FAILED",
  "VERIFICATION_INCONCLUSIVE",
  "FORMAT_INVALID",
  "JUDGE_OUTPUT_INVALID",
  "INSUFFICIENT_CANDIDATES",
  "POLICY_REFUSAL",
  "CONTEXT_PRECHECK_FAILED",
  "CONTEXT_BUDGET_EXHAUSTED",
  "MODE_NOT_AVAILABLE",
  "ROLE_UNRESOLVABLE",
  "RUN_INPUT_MISSING",
])

/**
 * How a compat caller hears that its run did not produce an answer. The run
 * exists and keeps its own record; the synchronous answer can only be one of
 * the statuses the compat endpoint has, so the run's error code is sorted:
 * money and session conflicts are 409, an answer that could not be accepted is
 * 422, a provider that throttled is 429, and anything that may go through on
 * a retry — a provider outage, a deadline, an unknown outcome — is 503.
 */
export function chatFailureStatus(code: string): ChatFailureStatus {
  if (CONFLICT_CODES.has(code)) return 409
  if (UNPROCESSABLE_CODES.has(code)) return 422
  if (code === "RATE_LIMITED") return 429
  return 503
}
