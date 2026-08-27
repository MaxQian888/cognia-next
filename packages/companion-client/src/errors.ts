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
    readonly status: number
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
    const detail = body?.error as Record<string, unknown> | undefined
    throw new CompanionApiError(
      typeof detail?.message === "string" ? detail.message : `HTTP ${response.status}`,
      typeof detail?.code === "string" ? detail.code : "",
      response.status
    )
  }
  return body ?? {}
}
