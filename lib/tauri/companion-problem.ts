/**
 * The one failure document a Cognia Host answers with (ADR-0175), as the app
 * sees it.
 *
 * The parser lives in `@cognia/companion-client` because the CLI worker and
 * the browser extension read the same document. This module is the app's
 * import seam for it, plus the bridge from a document to the transport's
 * `CompanionError` constructor arguments.
 */

import { parseProblem, problemRetryAfterMs, type Problem } from "@cognia/companion-client"

export {
  isProblem,
  parseProblem,
  problemRetryAfterMs,
  PROBLEM_CONTENT_TYPE,
  PROBLEM_TYPE_BASE,
  type Problem,
} from "@cognia/companion-client"

export interface CompanionErrorInit {
  code: string
  message: string
  retryable: boolean
  retryAfterMs?: number
}

/**
 * The transport's error constructor arguments for a document. A code with no
 * detail keeps the code as its message so the failure still says something.
 */
export function companionErrorInitFromProblem(problem: Problem): CompanionErrorInit {
  const retryAfterMs = problemRetryAfterMs(problem)
  return {
    code: problem.code,
    message: problem.detail.length > 0 ? problem.detail : problem.code,
    retryable: problem.retryable,
    ...(retryAfterMs === null ? {} : { retryAfterMs }),
  }
}

/**
 * Read a Host refusal out of an already-parsed body, falling back to the
 * status when the body carries no document. Never throws.
 */
export function companionErrorInitFromBody(body: unknown, status: number): CompanionErrorInit {
  const problem = parseProblem(body, status)
  if (problem) return companionErrorInitFromProblem(problem)
  return {
    code: status >= 500 ? "server_error" : `http_${status}`,
    message: `HTTP ${status}`,
    retryable: status >= 500,
  }
}
