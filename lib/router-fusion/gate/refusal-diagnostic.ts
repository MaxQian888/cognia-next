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
