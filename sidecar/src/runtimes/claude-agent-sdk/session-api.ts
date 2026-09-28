import type { SessionStore } from "@anthropic-ai/claude-agent-sdk"
// Top-level Claude Agent SDK session functions (ADR-0090 plan Stage 4).
//
// These are MODULE-level exports, not `Query` methods: they read and mutate
// session transcripts without a live session, so they cannot ride the `control`
// frame (which resolves a running query by id). They get their own frame:
//
//   out: { type: "session_api", requestId, method, params }
//   in:  { type: "session_api_response", requestId, ok, result?, error? }
//
// The allowlist is the same defence as `control.mjs`: a malformed or hostile
// frame must never reflectively reach an arbitrary SDK export. Everything here
// is pure routing + validation, so it is unit-testable without a live SDK — the
// actual functions are injected.

import {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  getSubagentMessages,
  importSessionToStore,
  listSessions,
  listSubagents,
  renameSession,
  resolveSettings,
  tagSession,
} from "@anthropic-ai/claude-agent-sdk"

/**
 * Allowlisted methods, mapped to how each one is called.
 *
 * `mutates` drives one thing: a read is safe to serve on any session, a write
 * is not, and the caller needs to know which is which without reading the SDK
 * docs. `store` marks the methods that take a `SessionStore` — the sidecar
 * builds it, the caller only ever names the descriptor.
 */
export const SESSION_API_METHODS = {
  listSessions: { mutates: false, store: true },
  getSessionInfo: { mutates: false, store: true },
  getSessionMessages: { mutates: false, store: true },
  listSubagents: { mutates: false, store: true },
  getSubagentMessages: { mutates: false, store: true },
  renameSession: { mutates: true, store: true },
  tagSession: { mutates: true, store: true },
  deleteSession: { mutates: true, store: true },
  forkSession: { mutates: true, store: true },
  importSessionToStore: { mutates: true, store: true },
  // Reads the settings layers only — no session, no store.
  resolveSettings: { mutates: false, store: false },
}

export function isSessionApiMethod(method: unknown): method is keyof typeof SESSION_API_METHODS {
  return typeof method === "string" && Object.hasOwn(SESSION_API_METHODS, method)
}

/** Default SDK bindings. Injectable so the routing can be tested without one. */
export const DEFAULT_SESSION_API = {
  listSessions,
  getSessionInfo,
  getSessionMessages,
  listSubagents,
  getSubagentMessages,
  renameSession,
  tagSession,
  deleteSession,
  forkSession,
  importSessionToStore,
  resolveSettings,
}

const str = (v: unknown) => typeof v === "string" && v.length > 0

/**
 * Validate a call's params. Returns an error code, or null when it is fine.
 *
 * Four of these mutate a user's transcripts on disk — `deleteSession` removes
 * one outright — so a missing id must be refused here rather than reaching the
 * SDK, where an empty string can mean "search every project directory".
 */
export function sessionApiParamError(method: unknown, params?: Record<string, unknown> | null) {
  const p = params ?? {}
  switch (method) {
    case "listSessions":
    case "resolveSettings":
      return null
    case "getSessionInfo":
    case "getSessionMessages":
    case "listSubagents":
    case "deleteSession":
    case "forkSession":
    case "importSessionToStore":
      return str(p.sessionId) ? null : "invalid_session_id"
    case "getSubagentMessages":
      if (!str(p.sessionId)) return "invalid_session_id"
      return str(p.agentId) ? null : "invalid_agent_id"
    case "renameSession":
      if (!str(p.sessionId)) return "invalid_session_id"
      return str(p.title) ? null : "invalid_title"
    case "tagSession":
      if (!str(p.sessionId)) return "invalid_session_id"
      // `null` is the documented "clear the tag" value, so it must pass.
      return p.tag === null || str(p.tag) ? null : "invalid_tag"
    default:
      return "unknown_method"
  }
}

/**
 * Invoke one allowlisted method.
 *
 * `store` is the live `SessionStore` (or null). It is attached to `options`
 * rather than taken from the params so a caller cannot ask for a different
 * store than its own session's — the descriptor names a backend, never a
 * location, and this is where that guarantee is enforced.
 *
 */
export type SessionApi = {
  [K in keyof typeof DEFAULT_SESSION_API]: (
    ...args: Parameters<(typeof DEFAULT_SESSION_API)[K]>
  ) => unknown
}
export interface SessionApiCall {
  method: unknown
  params?: Record<string, unknown> | null
  store?: SessionStore | null
  api?: SessionApi
}
export async function callSessionApi({
  method,
  params,
  store,
  api = DEFAULT_SESSION_API,
}: SessionApiCall) {
  if (!isSessionApiMethod(method)) throw new Error("unknown_method")
  const paramError = sessionApiParamError(method, params)
  if (paramError) throw new Error(paramError)

  const p = (params ?? {}) as {
    sessionId: string
    agentId: string
    title: string
    tag: string | null
    dir?: string
  }
  const spec = SESSION_API_METHODS[method]
  // `dir` scopes a filesystem search to one project. Passed through verbatim;
  // it is the SDK's own option and means nothing to a store-backed call.
  const options = {
    ...(p.dir ? { dir: p.dir } : {}),
    ...(spec.store && store ? { sessionStore: store } : {}),
  }

  switch (method) {
    case "listSessions":
      return api.listSessions(options)
    case "getSessionInfo":
      return api.getSessionInfo(p.sessionId, options)
    case "getSessionMessages":
      // The SDK returns the COMPACTED chain here. Callers that need the raw
      // history read the store directly — noted so nobody "fixes" a short
      // result by re-reading through this path.
      return api.getSessionMessages(p.sessionId, options)
    case "listSubagents":
      return api.listSubagents(p.sessionId, options)
    case "getSubagentMessages":
      return api.getSubagentMessages(p.sessionId, p.agentId, options)
    case "renameSession":
      return api.renameSession(p.sessionId, p.title, options)
    case "tagSession":
      return api.tagSession(p.sessionId, p.tag, options)
    case "deleteSession":
      return api.deleteSession(p.sessionId, options)
    case "forkSession":
      return api.forkSession(p.sessionId, options)
    case "importSessionToStore": {
      // The one method that REQUIRES a store: without one there is nothing to
      // import into, and the SDK would throw further away from the caller.
      if (!store) throw new Error("no_session_store")
      return api.importSessionToStore(p.sessionId, store, options)
    }
    case "resolveSettings":
      return api.resolveSettings(options as Parameters<typeof resolveSettings>[0])
    default:
      throw new Error("unknown_method")
  }
}

/** Shape the response frame. Mirrors `buildControlResponse`. */
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

/**
 * Handle one inbound `session_api` frame. Never throws — like the control
 * handler, a bad request must not fault the host.
 *
 */
export async function handleSessionApi(
  msg:
    | { requestId?: unknown; method?: unknown; params?: Record<string, unknown> | null }
    | null
    | undefined,
  {
    emit,
    store = null,
    api = DEFAULT_SESSION_API,
  }: {
    emit: (frame: Record<string, unknown>) => void
    store?: SessionStore | null
    api?: SessionApi
  }
) {
  const { requestId, method, params } = msg ?? {}
  try {
    const result = await callSessionApi({ method, params, store, api })
    emit(buildSessionApiResponse({ requestId, method, ok: true, result }))
  } catch (err) {
    emit(
      buildSessionApiResponse({
        requestId,
        method,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    )
  }
}
