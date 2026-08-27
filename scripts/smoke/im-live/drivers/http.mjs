// Shared HTTP for the platform drivers.
//
// The drivers deliberately do NOT reuse `lib/connectors/adapters/*` — the point
// of the harness is to have a second, independent implementation on the wire.
// If the driver called the same code as the target, one bug in serialization or
// identity handling would be present on both sides and cancel out into a green
// run. So this is a small, plain client instead.
//
// Errors carry the platform's own error body because that is what tells an
// operator which permission or scope is missing. The report layer redacts
// before anything is printed or written.

export class DriverHttpError extends Error {
  constructor(message, { status, body, url, method } = {}) {
    super(message)
    this.name = "DriverHttpError"
    this.status = status
    this.body = body
    this.url = url
    this.method = method
  }
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * One JSON request.
 *
 * `expectJson: false` is for endpoints that answer 204 with an empty body
 * (Discord deletes), where `response.json()` would throw on valid success.
 */
export async function requestJson({
  url,
  method = "GET",
  headers = {},
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  expectJson = true,
}) {
  const init = { method, headers: { ...headers } }
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body)
    init.headers["content-type"] = init.headers["content-type"] ?? "application/json"
  }
  init.signal = AbortSignal.timeout(timeoutMs)

  let response
  try {
    response = await fetchImpl(url, init)
  } catch (error) {
    const reason =
      error?.name === "TimeoutError"
        ? `timed out after ${timeoutMs}ms`
        : String(error?.message ?? error)
    throw new DriverHttpError(`${method} ${url} failed: ${reason}`, { url, method })
  }

  const text = await response.text()
  let parsed
  if (text !== "") {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
  }

  if (!response.ok) {
    throw new DriverHttpError(`${method} ${url} → HTTP ${response.status}: ${truncate(text)}`, {
      status: response.status,
      body: parsed ?? text,
      url,
      method,
    })
  }
  if (expectJson && parsed === undefined && text !== "") {
    throw new DriverHttpError(`${method} ${url} returned a non-JSON body: ${truncate(text)}`, {
      status: response.status,
      body: text,
      url,
      method,
    })
  }
  return parsed
}

function truncate(text, max = 400) {
  const flat = String(text).replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll `probe` until it returns a non-empty result, the deadline passes, or the
 * caller aborts.
 *
 * Returns `null` on timeout rather than throwing: "no reply arrived" is an
 * expected outcome the diagnostic table has a row for, not an exception.
 */
export async function pollUntil(
  probe,
  { timeoutMs, intervalMs = 2000, signal, now = Date.now, sleepImpl = sleep }
) {
  const deadline = now() + timeoutMs
  for (;;) {
    if (signal?.aborted) return null
    const found = await probe()
    if (found !== null && found !== undefined && !(Array.isArray(found) && found.length === 0)) {
      return found
    }
    const remaining = deadline - now()
    if (remaining <= 0) return null
    await sleepImpl(Math.min(intervalMs, remaining))
  }
}

/** Best-effort deletion: report per-message outcomes instead of aborting the run. */
export async function cleanupMessages(ids, deleteOne) {
  const deleted = []
  const retained = []
  for (const id of ids) {
    if (!id) continue
    try {
      await deleteOne(id)
      deleted.push(id)
    } catch (error) {
      retained.push({ id, reason: error?.message ?? String(error) })
    }
  }
  return { deleted, retained, ok: retained.length === 0 }
}
