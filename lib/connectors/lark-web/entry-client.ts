/**
 * Client logic behind `/lark/entry` (plan 2026-07-24 P3.2/P3.3).
 *
 * Kept out of the page component so the whole flow is unit-testable:
 * capture the SSO fragment → require a live session (else compute the login
 * bounce) → POST the entry/surface token to the companion's resolve endpoint
 * → poll async surface resolutions → produce one terminal outcome the page
 * renders or navigates on.
 */

import {
  buildLarkLoginUrl,
  captureLarkSessionFromLocation,
  clearLarkWebSession,
  decodeJwtPayload,
  getLarkWebSession,
} from "./session"

export type LarkEntryOutcome =
  | { kind: "navigate"; conversationKey: string; sessionId?: string }
  | { kind: "login"; loginUrl: string }
  | {
      kind: "error"
      code:
        | "entry_missing"
        | "entry_expired"
        | "entry_consumed"
        | "forbidden"
        | "unbound"
        | "resolve_failed"
        | "timeout"
    }

export interface ResolveLarkEntryOptions {
  /** `location.search` of the entry page. */
  search: string
  /** Path + search used as the SSO return target. */
  returnTo: string
  /** Companion origin; empty string = same origin. */
  apiBase?: string
  fetchFn?: typeof fetch
  /** Poll cadence/budget — injectable for tests. */
  pollIntervalMs?: number
  pollBudgetMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** Companion origin the static export talks to; "" = same origin. */
export function resolveLarkApiBase(): string {
  return (process.env.NEXT_PUBLIC_COGNIA_LARK_API_BASE ?? "").trim().replace(/\/+$/, "")
}

function deniedCode(status: number, body: { error?: string }): LarkEntryOutcome {
  if (status === 410) return { kind: "error", code: "entry_expired" }
  if (status === 409) return { kind: "error", code: "entry_consumed" }
  if (status === 403) {
    return body.error === "principal_unbound"
      ? { kind: "error", code: "unbound" }
      : { kind: "error", code: "forbidden" }
  }
  return { kind: "error", code: "resolve_failed" }
}

export async function resolveLarkEntry(
  options: ResolveLarkEntryOptions
): Promise<LarkEntryOutcome> {
  // `globalThis` access keeps this evaluable in environments without fetch
  // (older jsdom) — the paths that never fetch still work there.
  const fetchFn = options.fetchFn ?? (globalThis.fetch as typeof fetch | undefined)
  const apiBase = options.apiBase ?? resolveLarkApiBase()
  const params = new URLSearchParams(options.search)
  const entryToken = params.get("entry")
  const surfaceToken = params.get("surface")
  const token = entryToken ?? surfaceToken
  if (!token) return { kind: "error", code: "entry_missing" }

  captureLarkSessionFromLocation()
  const session = getLarkWebSession()
  if (!session) {
    // The adapter id rides inside the (unverified) token payload purely so
    // the login bounce can target the right Lark app.
    const adapterId = decodeJwtPayload(token)?.adapter_id
    if (typeof adapterId !== "string" || !adapterId) {
      return { kind: "error", code: "resolve_failed" }
    }
    return { kind: "login", loginUrl: buildLarkLoginUrl(apiBase, adapterId, options.returnTo) }
  }

  if (!fetchFn) return { kind: "error", code: "resolve_failed" }
  const response = await fetchFn(`${apiBase}/integrations/lark/entry/resolve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session}`,
    },
    body: JSON.stringify(entryToken ? { entry: entryToken } : { surface: surfaceToken }),
  }).catch(() => null)
  if (!response) return { kind: "error", code: "resolve_failed" }

  if (response.status === 401) {
    // Session rejected server-side (expiry skew, secret rotation) — drop it
    // and restart via login.
    clearLarkWebSession()
    const adapterId = decodeJwtPayload(token)?.adapter_id
    if (typeof adapterId !== "string" || !adapterId) {
      return { kind: "error", code: "resolve_failed" }
    }
    return { kind: "login", loginUrl: buildLarkLoginUrl(apiBase, adapterId, options.returnTo) }
  }

  const body = (await response.json().catch(() => ({}))) as {
    status?: string
    conversationKey?: string
    sessionId?: string
    requestId?: string
    error?: string
  }

  if (response.status === 200 && body.status === "done" && body.conversationKey) {
    return { kind: "navigate", conversationKey: body.conversationKey, sessionId: body.sessionId }
  }
  if (response.status === 202 && body.requestId) {
    return pollIntent({ ...options, apiBase, fetchFn }, session, body.requestId)
  }
  return deniedCode(response.status, body)
}

async function pollIntent(
  options: ResolveLarkEntryOptions & { apiBase: string; fetchFn: typeof fetch },
  session: string,
  requestId: string
): Promise<LarkEntryOutcome> {
  const interval = options.pollIntervalMs ?? 1000
  const budget = options.pollBudgetMs ?? 30_000
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const attempts = Math.max(1, Math.floor(budget / interval))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(interval)
    const response = await options
      .fetchFn(`${options.apiBase}/integrations/lark/intent/${encodeURIComponent(requestId)}`, {
        headers: { Authorization: `Bearer ${session}` },
      })
      .catch(() => null)
    if (!response) continue
    const body = (await response.json().catch(() => ({}))) as {
      status?: string
      result?: { conversationKey?: string }
      error?: string
    }
    if (body.status === "done" && body.result?.conversationKey) {
      return { kind: "navigate", conversationKey: body.result.conversationKey }
    }
    if (body.status === "error") {
      return body.error === "membership_denied"
        ? { kind: "error", code: "forbidden" }
        : { kind: "error", code: "resolve_failed" }
    }
  }
  return { kind: "error", code: "timeout" }
}
