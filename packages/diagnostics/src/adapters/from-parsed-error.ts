/**
 * `@cognia/error-parsers` category ids → {@link DiagnosticCode}.
 *
 * The parsers already classify raw error text into 23 stable category ids, and
 * those ids were chosen as the base of the diagnostic vocabulary — so this
 * adapter is a *lift*, not a translation: the strings are identical and the
 * only work is validating them against the registry.
 *
 * Deliberately does NOT import `@cognia/error-parsers`. That package's
 * `src/types.ts` reaches into `@/lib/terminal/stack-trace`, which is why it
 * can't build standalone; importing it here would spread that to every consumer
 * of this one. Instead the input is described structurally — any object with
 * the two fields we read satisfies it.
 */

import { isDiagnosticCode } from "../registry"
import type { DiagnosticCode } from "../types"

/** Structural subset of `ParsedNode` — no import, no coupling. */
export interface ParsedErrorNodeLike {
  kind: string
  /** Stable category id, on `category` and `statusCode` nodes. */
  category?: string
  /** HTTP status, on `statusCode` nodes. */
  status?: number
}

/** Structural subset of `ParsedError`. */
export interface ParsedErrorLike {
  nodes: readonly ParsedErrorNodeLike[]
}

export interface ParsedErrorDiagnosis {
  code: DiagnosticCode
  /** Present when a `statusCode` node carried one. */
  httpStatus?: number
}

/**
 * Lift the first recognised category out of a parse result.
 *
 * Returns `null` when the parsers found nothing classifiable, so the caller can
 * fall through to the next classifier rather than mislabelling the failure as
 * `unknown` too early.
 */
export function diagnoseParsedError(parsed: ParsedErrorLike): ParsedErrorDiagnosis | null {
  let httpStatus: number | undefined

  for (const node of parsed.nodes) {
    // A `statusCode` node may carry the status without a category (a bare 404),
    // so remember the first one even if it doesn't resolve a code on its own.
    if (httpStatus === undefined && typeof node.status === "number") {
      httpStatus = node.status
    }
    if (node.category && isDiagnosticCode(node.category)) {
      return httpStatus === undefined
        ? { code: node.category }
        : { code: node.category, httpStatus }
    }
  }

  return null
}
