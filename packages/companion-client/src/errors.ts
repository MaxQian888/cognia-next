import { parseProblem, problemRetryAfterMs } from "./problem"

/**
 * A companion API refusal, carrying the machine-readable `code` alongside the
 * human message.
 *
 * The message alone is not enough to act on: two 403s with the same shape can
 * need opposite remedies (a missing capability wants a grant, a host-wide
 * switch wants the switch), and callers were otherwise left string-matching
 * English server copy to tell them apart.
 */
export class CompanionApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    /**
     * How long the Host asked the caller to wait before trying again, when it
     * said (`details.retryAfterSeconds`, else a `Retry-After` header). A poller
     * that ignores it hammers a Host that is shedding load.
     */
    readonly retryAfterMs: number | null = null
  ) {
    super(message)
    this.name = "CompanionApiError"
  }
}

/** The refusal code from a caught companion API error, when it has one. */
export function companionErrorCode(error: unknown): string | null {
  return error instanceof CompanionApiError ? error.code : null
}

/**
 * Read a JSON body, turning a non-2xx into a {@link CompanionApiError}.
 *
 * A body that is not JSON at all is not an error on its own — a 204 and an
 * empty 200 both legitimately have none — so only the status decides.
 */
export async function expectCompanionJson(
  responsePromise: Promise<Response>
): Promise<Record<string, unknown>> {
  const response = await responsePromise
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    const problem = parseProblem(body, response.status)
    throw new CompanionApiError(
      problem && problem.detail.length > 0 ? problem.detail : `HTTP ${response.status}`,
      problem?.code ?? "",
      response.status,
      (problem ? problemRetryAfterMs(problem) : null) ?? retryAfterHeaderMs(response)
    )
  }
  return body ?? {}
}

/** A `Retry-After` header in seconds, as milliseconds; dates are not used here. */
function retryAfterHeaderMs(response: Response): number | null {
  const raw = response.headers?.get?.("retry-after")
  if (!raw) return null
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null
}

/** The wait a caught companion API error asked for, when it asked. */
export function companionRetryAfterMs(error: unknown): number | null {
  return error instanceof CompanionApiError ? error.retryAfterMs : null
}
