/**
 * `POST /v1/chat/completions` for the virtual router models, on the brain side
 * (ADR-0188 D13, B3).
 *
 * The gateway serves the compat HTTP shape: it creates the run here, waits on
 * the run's events (heartbeat comments only, never a draft, while the run is
 * not verified — DESIGN §22), then asks here for the compat answer. A compat
 * run is an ordinary Run API run in its own new conversation, created by the
 * same `acceptRun` a `POST /v1/runs` goes through, so idempotency, actor
 * isolation, the stored input and the account policy are the same promises.
 */

import {
  CHAT_COMPAT_ENDPOINT,
  chatFailureStatus,
  chatResponseOf,
  chatRunInputOf,
  isTerminalRunStatus,
  isVirtualRouterModel,
  parseChatCompatRequest,
  type ChatResponse,
  type RunStatus,
} from "@cognia/router-fusion"

import type { FusionLedgerStore } from "../db/ledger-store"
import {
  acceptRun,
  billingOf,
  COMPAT_EXECUTABLE_MODES,
  issuesToError,
  readRunForActor,
  readRunResult,
  requireScope,
  type RunApiActor,
  type RunApiDeps,
  type RunApiResult,
  type RunCreated,
} from "./run-api"

/** What the gateway learns when it asks for a compat answer. */
export type ChatRunRead =
  /** Still working: the gateway keeps waiting on the run's events. */
  | { state: "pending"; status: RunStatus; lastSeq: number }
  | { state: "succeeded"; response: ChatResponse }

/** The model name echoed back when the gateway forwarded something that is not one of ours. */
const FALLBACK_MODEL_NAME = "cognia/auto"

/** Validate a compat body and create its run. Answers with what `/v1/runs` would have. */
export async function createChatRunFromApi(
  deps: RunApiDeps,
  input: { actor: RunApiActor; body: unknown; idempotencyKey?: string }
): Promise<RunApiResult<RunCreated>> {
  const scopeError = requireScope(input.actor, "runs:create")
  if (scopeError) return { ok: false, error: scopeError }
  const parsed = parseChatCompatRequest(input.body)
  if (!parsed.ok) return { ok: false, error: issuesToError(parsed.issues) }
  const mapped = chatRunInputOf(parsed.value, COMPAT_EXECUTABLE_MODES, await deps.policy())
  if (!mapped.ok) return { ok: false, error: issuesToError(mapped.issues) }
  return acceptRun(deps, {
    actor: input.actor,
    request: mapped.value.request,
    messages: mapped.value.messages,
    jsonSchema: mapped.value.jsonSchema,
    body: input.body,
    endpoint: CHAT_COMPAT_ENDPOINT,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  })
}

/**
 * Prompt and completion tokens over every call the run made (DESIGN §22: the
 * compat usage is the normalized sum, not one model's bill). A call with no
 * usage on file adds nothing; its cost is still in the run's billing.
 */
export async function runTokenTotals(
  store: FusionLedgerStore,
  runId: string
): Promise<{ promptTokens: number; completionTokens: number }> {
  const attempts = await store.db.fusionCallAttempts.where("runId").equals(runId).toArray()
  let promptTokens = 0
  let completionTokens = 0
  for (const attempt of attempts) {
    const usage = attempt.usage
    if (!usage) continue
    const count = (key: string) => {
      const value = usage[key]
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
    }
    promptTokens +=
      count("input_uncached_tokens") +
      count("input_cache_read_tokens") +
      count("input_cache_write_5m_tokens") +
      count("input_cache_write_1h_tokens")
    completionTokens +=
      count("output_tokens") +
      (usage.reasoning_included_in_output === false ? count("reasoning_tokens") : 0)
  }
  return { promptTokens, completionTokens }
}

/**
 * The compat answer for a run, once it has one. A run that ended any other
 * way is an error with the run's own code, sorted into the statuses the
 * endpoint has; the run id travels in the details so the caller can look the
 * run up.
 */
export async function chatResultFromApi(
  deps: RunApiDeps,
  input: { actor: RunApiActor; runId: string; model: unknown }
): Promise<RunApiResult<ChatRunRead>> {
  const scopeError = requireScope(input.actor, "runs:read")
  if (scopeError) return { ok: false, error: scopeError }
  const store = await deps.store()
  const run = await readRunForActor(store, input.runId, input.actor)
  if (!run)
    return { ok: false, error: { status: 404, code: "RUN_NOT_FOUND", message: "no such run" } }
  if (!isTerminalRunStatus(run.status)) {
    return { ok: true, value: { state: "pending", status: run.status, lastSeq: run.lastSeq } }
  }
  const details = { run_id: run.runId, run_status: run.status }
  if (run.status !== "succeeded") {
    const code =
      run.error?.code ??
      (run.status === "cancelled"
        ? "RUN_CANCELLED"
        : run.status === "expired"
          ? "DEADLINE_EXCEEDED"
          : "RUN_FAILED")
    return {
      ok: false,
      error: {
        status: chatFailureStatus(code),
        code,
        message: run.error?.message ?? `the run ended ${run.status} without an answer`,
        details,
      },
    }
  }
  const sealed = await readRunResult(store, run)
  if (!sealed.result) {
    return {
      ok: false,
      error: {
        status: 404,
        code: sealed.expired ? "RESULT_EXPIRED" : "RESULT_MISSING",
        message: sealed.expired
          ? "the run's answer is past its retention window"
          : "the run has no answer on file",
        details,
      },
    }
  }
  const model = isVirtualRouterModel(input.model) ? (input.model as string) : FALLBACK_MODEL_NAME
  return {
    ok: true,
    value: {
      state: "succeeded",
      response: chatResponseOf({
        runId: run.runId,
        model,
        createdAtMs: run.createdAt,
        result: sealed.result,
        billing: billingOf(run),
        usage: await runTokenTotals(store, run.runId),
      }),
    },
  }
}
