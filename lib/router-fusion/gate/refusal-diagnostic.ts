/**
 * The chat diagnostic for a Router + Fusion refusal (ADR-0188).
 *
 * A refusal is an answer, not a fault: the turn did not run because it would
 * have broken a budget, limit, deadline or data rule. The code alone
 * (`RUN_BUDGET_EXHAUSTED`) says nothing to a reader, so the translated sentence
 * goes in `message` and the code with the engine's reasons goes in `detail`.
 *
 * Loaded statically by the shared chat path, so it imports nothing from the
 * rest of Router + Fusion; the translator is loaded only when a refusal exists.
 */

import type { CogniaDiagnostic } from "@cognia/diagnostics"
import { diagnosticFromCode } from "@/lib/diagnostics/to-diagnostic"

import { RouterFusionRefusalError } from "./faults"

export type RefusalTranslator = (key: string, values?: Record<string, unknown>) => string

export interface RouterFusionRefusalDiagnosticInput {
  code: string
  sessionId: string
  /** Engine reasons or the sidecar's own words; shown collapsed as evidence. */
  reasons?: readonly string[]
  spanId?: string
  /**
   * `refused` (the default): the turn never ran. `failed`: a cascade or panel
   * run started and stopped before its answer was verified (B3); the code is
   * the run's own error code and reads from the same sentences.
   */
  kind?: "refused" | "failed"
  /** Test seam. */
  translator?: () => Promise<RefusalTranslator>
}

const NAMESPACE = "routerFusion.refusal"

/**
 * Every refusal or failure code the chat path can put in front of a reader,
 * each of which must have a sentence under `routerFusion.refusal` in every
 * locale (pinned by `refusal-diagnostic.test.ts`). Anything else still reads
 * as the `unknown` sentence naming its code. Where each comes from:
 *
 *  - routing and selection (`build-options`, `route-chat-turn`,
 *    `chat-fusion-turn`, the image check of `hooks/chat/router-fusion-chat-turn`);
 *  - run creation and the one-run grant (`chat-runs` begin, `chat-turn-bridge`);
 *  - a reservation the renderer answered (`chat-runs` reserve: the live policy
 *    check, the per-call amount, the envelope check, the ledger's prepare and
 *    dispatch), shown on the run card and in the sidecar's `session_ended`;
 *  - the sidecar's own gate (`call-ledger-gate`);
 *  - a direct run's seal (`chat-runs` finalize / abort, stale-run recovery);
 *  - a cascade or panel run (`orchestrator-host`, the `durable-call`, `cascade`
 *    and `panel` workflows).
 */
export const CHAT_SURFACED_CODES = [
  // routing and selection
  "ROUTE_NO_SOLUTION",
  "FUSION_TEXT_ONLY",
  "ROUTE_EXPIRED",
  "PII_BLOCKED",
  "ROUTER_FUSION_DISABLED",
  "ROUTER_FUSION_UNAVAILABLE",
  // run creation
  "RUN_EXISTS",
  "SESSION_BUSY",
  "TENANT_BUDGET_EXHAUSTED",
  "DECLINED_GRANT",
  // reservations
  "DEPLOYMENT_UNKNOWN",
  "PROVIDER_UNAVAILABLE",
  "RESTRICTED_NOT_GRANTED",
  "DEPLOYMENT_NOT_IN_SNAPSHOT",
  "DATA_CLASS_NOT_ALLOWED",
  "PRICE_UNKNOWN",
  "RUN_NOT_RUNNING",
  "RUN_TERMINAL",
  "BUDGET_FROZEN",
  "DEADLINE_EXCEEDED",
  "MAX_MODEL_CALLS",
  "RUN_BUDGET_EXHAUSTED",
  "STAGE_NOT_HELD",
  "FENCED",
  "REVOKED",
  "STEP_OUTCOME_UNKNOWN",
  "ATTEMPTS_EXHAUSTED",
  "STEP_ALREADY_COMMITTED",
  "NOT_PREPARED",
  // the sidecar's gate
  "SESSION_CLOSED",
  "REFUSED",
  // a direct run's seal
  "CALL_FAILED",
  "DISPATCH_FAILED",
  "RUN_SETUP_FAILED",
  "RUN_LOST",
  // a cascade or panel run
  "RUN_NOT_FOUND",
  "RUN_INPUT_MISSING",
  "RUN_BUSY",
  "ROLE_UNRESOLVABLE",
  "INTERNAL",
  "CALL_OUTCOME_UNKNOWN",
  "POLICY_REFUSAL",
  "FORMAT_INVALID",
  "VERIFICATION_FAILED",
  "CONTEXT_PRECHECK_FAILED",
  "CONTEXT_BUDGET_EXHAUSTED",
  "FUSION_INSUFFICIENT_CANDIDATES",
  "JUDGE_OUTPUT_INVALID",
  "CANCELLED",
] as const

export function isRouterFusionRefusal(error: unknown): error is RouterFusionRefusalError {
  return (
    error instanceof RouterFusionRefusalError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { kind?: unknown }).kind === "router_fusion_refusal" &&
      typeof (error as { code?: unknown }).code === "string")
  )
}

async function defaultTranslator(): Promise<RefusalTranslator> {
  const { getRuntimeTranslator } = await import("@/lib/i18n/runtime-translator")
  return getRuntimeTranslator(NAMESPACE)
}

export async function routerFusionRefusalDiagnostic(
  input: RouterFusionRefusalDiagnosticInput
): Promise<CogniaDiagnostic> {
  let message = input.code
  try {
    const t = await (input.translator ?? defaultTranslator)()
    const sentence = t(input.code)
    // The runtime translator answers a missing key with the key's own path.
    message =
      sentence && sentence !== `${NAMESPACE}.${input.code}`
        ? sentence
        : t("unknown", { code: input.code })
  } catch {
    // The bare code still tells a reader what happened.
  }
  const reasons = (input.reasons ?? []).filter((reason) => reason.trim() !== "")
  const failed = input.kind === "failed"
  const diagnostic = diagnosticFromCode(failed ? "routerFusionRunFailed" : "routerFusionRefused", {
    source: "chat",
    message,
    meta: {
      sessionId: input.sessionId,
      ...(input.spanId ? { spanId: input.spanId } : {}),
      extra: failed ? { runErrorCode: input.code } : { refusalCode: input.code },
    },
  })
  return {
    ...diagnostic,
    detail: [input.code, ...reasons].join("\n"),
  }
}

/** The refusal carried by a thrown error, or null when the error is not one. */
export function refusalOf(error: unknown): { code: string; reasons: string[] } | null {
  if (!isRouterFusionRefusal(error)) return null
  const reasons = (error.details as { reasons?: unknown } | undefined)?.reasons
  return {
    code: error.code,
    reasons: Array.isArray(reasons)
      ? reasons.filter((r): r is string => typeof r === "string")
      : [],
  }
}
