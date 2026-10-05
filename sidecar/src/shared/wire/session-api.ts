// The `session_api_response` frame (ADR-0217): shared so a host can answer a
// session-API request without loading the engine that serves it.

export function buildSessionApiResponse({
  requestId,
  method,
  ok,
  result,
  error,
}: {
  requestId?: unknown
  method?: unknown
  ok: boolean
  result?: unknown
  error?: unknown
}) {
  const msg: Record<string, unknown> = { type: "session_api_response", requestId, method, ok }
  if (ok) {
    if (result !== undefined) msg.result = result
  } else {
    msg.error = error ?? "error"
  }
  return msg
}
