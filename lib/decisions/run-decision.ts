/**
 * The one entry point for System-1 decisions (ADR-0194). Every caller — the
 * reply copilot, the plugin `ctx.decisions` API, the settings probe — goes
 * through here, so validation, privacy and error typing live in one place:
 *
 * 1. validate the request shape;
 * 2. resolve the provider (explicit id, else `settings.decisions.providerId`);
 * 3. refuse a plugin calling its own provider (the provider's `decide` would
 *    otherwise be able to recurse into itself through `ctx.decisions`);
 * 4. redact every string value (state + question text, never keys) and gate
 *    the result with `hasNoLeakingPiiDeep` — for EVERY provider: a plugin's
 *    `locality: "local"` is a claim the host cannot verify;
 * 5. race the provider against the caller's signal and a deadline (a
 *    python-backed provider cannot be interrupted across the RPC);
 * 6. normalize the envelope into typed answers / typed errors.
 */

import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"
import { loadDecisionSettings } from "@/lib/decisions/config"
import { getDecisionRegistry } from "@/lib/decisions/host-registry"
import {
  normalizeDecisionAnswers,
  normalizeDecisionRouting,
  normalizeDecisionTruncation,
} from "@/lib/decisions/normalize"
import type { DecisionRegistry } from "@/lib/decisions/registry"
import { validateDecisionRequest } from "@/lib/decisions/validate"
import {
  DECISION_ERROR_KINDS,
  type DecisionErrorKind,
  type DecisionProviderResponse,
  type DecisionQuestion,
  type DecisionQuestions,
  type DecisionRequest,
  type DecisionResult,
  type DecisionSettings,
  type DecisionState,
} from "@/types/decisions"

/** Upper bound on one provider call; laya answers in <1 s once loaded. */
export const DEFAULT_DECISION_TIMEOUT_MS = 30_000

const MAX_ERROR_MESSAGE_CHARS = 500

export interface RunDecisionOptions {
  /** Explicit provider; defaults to the one selected in settings. */
  providerId?: string
  signal?: AbortSignal
  /** Plugin making the call (plugin API only) — for the recursion guard. */
  callerPluginId?: string
  timeoutMs?: number
}

export interface RunDecisionDeps {
  registry: () => DecisionRegistry
  loadSettings: () => Promise<DecisionSettings>
}

const defaultDeps: RunDecisionDeps = {
  registry: getDecisionRegistry,
  loadSettings: loadDecisionSettings,
}

/** Provider-reported kinds that are not host kinds (laya's envelope). */
const PROVIDER_KIND_ALIASES: Readonly<Record<string, DecisionErrorKind>> = {
  not_ready: "provider_unavailable",
  invalid_question: "invalid_request",
  predict_failed: "provider_error",
}

function toErrorKind(kind: unknown): DecisionErrorKind {
  if (typeof kind !== "string") return "provider_error"
  if ((DECISION_ERROR_KINDS as readonly string[]).includes(kind)) return kind as DecisionErrorKind
  return PROVIDER_KIND_ALIASES[kind] ?? "provider_error"
}

function failure(
  kind: DecisionErrorKind,
  message: string,
  providerId?: string,
  status?: number
): DecisionResult {
  return {
    ok: false,
    ...(providerId ? { providerId } : {}),
    error: {
      kind,
      message: message.slice(0, MAX_ERROR_MESSAGE_CHARS),
      ...(status !== undefined ? { status } : {}),
    },
  }
}

type NoulCriteria = { true?: string; false?: string }

/** Redact every string VALUE in a JSON tree; object keys are left alone. */
function redactValue(value: unknown, counter: { n: number }): unknown {
  if (typeof value === "string") {
    const { redacted, map } = redactText(value)
    counter.n += Object.keys(map).length
    return redacted
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, counter))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, counter)])
    )
  }
  return value
}

function redactQuestion(question: DecisionQuestion, counter: { n: number }): DecisionQuestion {
  const instructions = redactValue(question.instructions, counter) as string
  if (question.type === "choice") {
    return {
      ...question,
      instructions,
      criteria: redactValue(question.criteria, counter) as Record<string, string>,
    }
  }
  if (question.type === "score") {
    return {
      ...question,
      instructions,
      criteria: redactValue(question.criteria, counter) as string[],
    }
  }
  return {
    ...question,
    instructions,
    ...(question.criteria
      ? { criteria: redactValue(question.criteria, counter) as NoulCriteria }
      : {}),
  }
}

/** The request as it may leave the host: PII replaced by `<KIND_NNN>` placeholders. */
export function redactDecisionRequest(request: DecisionRequest): {
  request: DecisionRequest
  redactions: number
} {
  const counter = { n: 0 }
  const questions: DecisionQuestions = {}
  for (const [id, question] of Object.entries(request.questions)) {
    questions[id] = redactQuestion(question, counter)
  }
  return {
    request: {
      state: redactValue(request.state, counter) as DecisionState,
      questions,
      ...(request.stateTrim ? { stateTrim: request.stateTrim } : {}),
    },
    redactions: counter.n,
  }
}

type Raced = { response: unknown } | { aborted: true } | { timedOut: true } | { threw: unknown }

async function race(
  work: () => Promise<DecisionProviderResponse>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Raced> {
  if (signal?.aborted) return { aborted: true }
  let timer: ReturnType<typeof setTimeout> | undefined
  let detach: (() => void) | undefined
  const stop = new Promise<Raced>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
    if (signal) {
      const onAbort = () => resolve({ aborted: true })
      signal.addEventListener("abort", onAbort, { once: true })
      detach = () => signal.removeEventListener("abort", onAbort)
    }
  })
  try {
    return await Promise.race([
      work().then(
        (response): Raced => ({ response }),
        (threw): Raced => ({ threw })
      ),
      stop,
    ])
  } finally {
    if (timer) clearTimeout(timer)
    detach?.()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function runDecision(
  input: unknown,
  options: RunDecisionOptions = {},
  deps: RunDecisionDeps = defaultDeps
): Promise<DecisionResult> {
  const validated = validateDecisionRequest(input)
  if (!validated.ok) return failure("invalid_request", validated.message, options.providerId)

  const providerId = options.providerId ?? (await deps.loadSettings()).providerId
  if (!providerId) return failure("no_provider", "no decision provider is selected")
  const provider = deps.registry().get(providerId)
  if (!provider) {
    return failure("no_provider", `decision provider "${providerId}" is not installed`, providerId)
  }
  if (options.callerPluginId && provider.pluginId === options.callerPluginId) {
    return failure(
      "recursive_provider",
      "a plugin cannot route decisions through its own provider",
      providerId
    )
  }

  const { request, redactions } = redactDecisionRequest(validated.request)
  if (!hasNoLeakingPiiDeep({ state: request.state, questions: request.questions })) {
    return failure("pii", "the request still contains personal data after redaction", providerId)
  }

  const started = Date.now()
  const raced = await race(
    () => provider.decide(request, { signal: options.signal }),
    options.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS,
    options.signal
  )
  if ("aborted" in raced)
    return failure("aborted", "the decision request was cancelled", providerId)
  if ("timedOut" in raced) {
    return failure(
      "timeout",
      `decision provider did not answer within ${options.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS} ms`,
      providerId
    )
  }
  if ("threw" in raced) {
    const message = raced.threw instanceof Error ? raced.threw.message : String(raced.threw)
    return failure("provider_error", message, providerId)
  }

  const response = raced.response
  if (!isRecord(response) || typeof response.ok !== "boolean") {
    return failure("provider_error", "decision provider returned a malformed reply", providerId)
  }
  if (!response.ok) {
    const error = isRecord(response.error) ? response.error : {}
    return failure(
      toErrorKind(error.kind),
      typeof error.message === "string" && error.message
        ? error.message
        : "decision provider failed",
      providerId,
      typeof error.status === "number" ? error.status : undefined
    )
  }

  const answers = normalizeDecisionAnswers(response.answers, request.questions)
  if (Object.keys(answers).length === 0) {
    return failure("provider_error", "decision provider returned no readable answers", providerId)
  }
  const routing = normalizeDecisionRouting(response.routing)
  const truncation = normalizeDecisionTruncation(response.truncation, request.questions)
  const latency = typeof response.latencyMs === "number" ? response.latencyMs : Date.now() - started
  return {
    ok: true,
    providerId,
    answers,
    latencyMs: Math.max(0, Math.round(latency)),
    ...(routing ? { routing } : {}),
    ...(truncation ? { truncation } : {}),
    ...(typeof response.stateTrimmed === "number" && response.stateTrimmed > 0
      ? { stateTrimmed: response.stateTrimmed }
      : {}),
    ...(response.stateTruncated === true ? { stateTruncated: true } : {}),
    ...(redactions > 0 ? { redactions } : {}),
  }
}
