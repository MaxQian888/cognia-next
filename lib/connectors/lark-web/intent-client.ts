/**
 * Client logic behind `/lark/shortcut` (plan 2026-07-24 P5) — the web page
 * Lark opens for a message shortcut (消息快捷操作) or `+`-menu entry.
 *
 * Lark hands the page a trigger code (`__trigger_id__` inside the
 * `bdp_launch_query` launch param); the page exchanges it for the selected
 * messages via the Lark JSSDK (`tt.getBlockActionSourceDetail`, injected
 * here as a seam — the SDK only exists inside Lark's webview), then submits
 * ONLY ids to the companion. Everything client-supplied is a request: the
 * brain re-verifies membership and every message id server-side, so a
 * malicious page can at worst import messages it could already read.
 *
 * The JSSDK detail payload's exact shape is client-version-dependent (the
 * official doc is JS-rendered; real-client verification is a runbook item),
 * so `extractMessageRefs` does a tolerant deep scan for message/chat id
 * keys instead of pinning one shape.
 */

import {
  buildLarkLoginUrl,
  captureLarkSessionFromLocation,
  clearLarkWebSession,
  decodeJwtPayload,
  getLarkWebSession,
} from "./session"

export interface ShortcutLaunch {
  triggerId?: string
  adapterId?: string
  chatId?: string
}

/**
 * Parse the shortcut page's launch query. `adapter_id` rides on the
 * AppLink we configure in the developer console; `__trigger_id__` arrives
 * either as a direct param or inside `bdp_launch_query` (JSON or nested
 * query-string — both observed encodings are accepted).
 */
export function parseShortcutLaunch(search: string): ShortcutLaunch {
  const params = new URLSearchParams(search)
  const launch: ShortcutLaunch = {
    triggerId: params.get("__trigger_id__") ?? undefined,
    adapterId: params.get("adapter_id") ?? undefined,
    chatId: params.get("chat_id") ?? undefined,
  }
  const blob = params.get("bdp_launch_query")
  if (blob && !launch.triggerId) {
    try {
      const parsed = JSON.parse(blob) as Record<string, unknown>
      if (typeof parsed.__trigger_id__ === "string") launch.triggerId = parsed.__trigger_id__
    } catch {
      const nested = new URLSearchParams(blob)
      launch.triggerId = nested.get("__trigger_id__") ?? launch.triggerId
    }
  }
  return launch
}

const MESSAGE_ID_KEYS = new Set(["message_id", "messageId", "open_message_id", "openMessageId"])
const CHAT_ID_KEYS = new Set(["chat_id", "chatId", "open_chat_id", "openChatId"])
const MAX_SCAN_DEPTH = 6

/**
 * Tolerant deep scan of the JSSDK trigger detail for message + chat ids.
 * Order-preserving, deduped, capped at Lark's own 20-message limit.
 */
export function extractMessageRefs(detail: unknown): { chatId?: string; messageIds: string[] } {
  const messageIds: string[] = []
  const seen = new Set<string>()
  let chatId: string | undefined

  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH || node === null || typeof node !== "object") return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && value) {
        if (MESSAGE_ID_KEYS.has(key) && !seen.has(value) && messageIds.length < 20) {
          seen.add(value)
          messageIds.push(value)
        } else if (CHAT_ID_KEYS.has(key) && !chatId) {
          chatId = value
        }
      } else {
        visit(value, depth + 1)
      }
    }
  }
  visit(detail, 0)
  return { chatId, messageIds }
}

export type LarkIntentSubmitOutcome =
  | { kind: "accepted"; requestId: string }
  | { kind: "login"; loginUrl: string }
  | { kind: "error"; code: string }

export interface SubmitIntentOptions {
  /** Route under /integrations/lark, e.g. "/shortcut/import". */
  path: string
  body: Record<string, unknown>
  /** Adapter for the login bounce when no session exists. */
  adapterId: string
  returnTo: string
  apiBase?: string
  fetchFn?: typeof fetch
}

function resolveApiBase(explicit?: string): string {
  if (explicit !== undefined) return explicit
  return (process.env.NEXT_PUBLIC_COGNIA_LARK_API_BASE ?? "").trim().replace(/\/+$/, "")
}

/** POST one intent with the SSO session; bounce to login when absent. */
export async function submitLarkIntent(
  options: SubmitIntentOptions
): Promise<LarkIntentSubmitOutcome> {
  const fetchFn = options.fetchFn ?? (globalThis.fetch as typeof fetch | undefined)
  const apiBase = resolveApiBase(options.apiBase)

  captureLarkSessionFromLocation()
  const session = getLarkWebSession()
  if (!session) {
    return {
      kind: "login",
      loginUrl: buildLarkLoginUrl(apiBase, options.adapterId, options.returnTo),
    }
  }
  if (!fetchFn) return { kind: "error", code: "submit_failed" }

  const response = await fetchFn(`${apiBase}/integrations/lark${options.path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
    body: JSON.stringify(options.body),
  }).catch(() => null)
  if (!response) return { kind: "error", code: "submit_failed" }
  if (response.status === 401) {
    clearLarkWebSession()
    return {
      kind: "login",
      loginUrl: buildLarkLoginUrl(apiBase, options.adapterId, options.returnTo),
    }
  }
  const body = (await response.json().catch(() => ({}))) as {
    requestId?: string
    error?: string
  }
  if (response.status === 202 && body.requestId) {
    return { kind: "accepted", requestId: body.requestId }
  }
  return { kind: "error", code: body.error ?? "submit_failed" }
}

export type LarkIntentResult =
  { kind: "done"; result: Record<string, unknown> } | { kind: "error"; code: string }

export interface PollIntentOptions {
  requestId: string
  apiBase?: string
  fetchFn?: typeof fetch
  pollIntervalMs?: number
  pollBudgetMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** Poll `/integrations/lark/intent/{id}` until the brain answers. */
export async function pollLarkIntent(options: PollIntentOptions): Promise<LarkIntentResult> {
  const fetchFn = options.fetchFn ?? (globalThis.fetch as typeof fetch | undefined)
  const apiBase = resolveApiBase(options.apiBase)
  const session = getLarkWebSession()
  if (!fetchFn || !session) return { kind: "error", code: "poll_failed" }
  const interval = options.pollIntervalMs ?? 1000
  const budget = options.pollBudgetMs ?? 30_000
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const attempts = Math.max(1, Math.floor(budget / interval))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(interval)
    const response = await fetchFn(
      `${apiBase}/integrations/lark/intent/${encodeURIComponent(options.requestId)}`,
      { headers: { Authorization: `Bearer ${session}` } }
    ).catch(() => null)
    if (!response) continue
    const body = (await response.json().catch(() => ({}))) as {
      status?: string
      result?: Record<string, unknown>
      error?: string
    }
    if (body.status === "done" && body.result) return { kind: "done", result: body.result }
    if (body.status === "error") return { kind: "error", code: body.error ?? "intent_failed" }
  }
  return { kind: "error", code: "timeout" }
}

export type ShortcutFlowOutcome =
  | { kind: "navigate"; conversationKey: string; sessionId?: string; imported?: number }
  | { kind: "login"; loginUrl: string }
  | { kind: "error"; code: string }

export interface ShortcutFlowOptions {
  search: string
  returnTo: string
  /** JSSDK seam: exchange the trigger code for the selected messages. */
  getTriggerDetail: (triggerId: string) => Promise<unknown>
  apiBase?: string
  fetchFn?: typeof fetch
  pollIntervalMs?: number
  pollBudgetMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** Full message-shortcut flow: launch query → JSSDK → submit → poll. */
export async function runShortcutImportFlow(
  options: ShortcutFlowOptions
): Promise<ShortcutFlowOutcome> {
  const launch = parseShortcutLaunch(options.search)
  const sessionAdapterId = decodeJwtPayload(getLarkWebSession() ?? "")?.adapter_id
  const adapterId =
    launch.adapterId ?? (typeof sessionAdapterId === "string" ? sessionAdapterId : undefined)
  if (!adapterId) return { kind: "error", code: "adapter_missing" }
  if (!launch.triggerId) return { kind: "error", code: "trigger_missing" }

  let detail: unknown
  try {
    detail = await options.getTriggerDetail(launch.triggerId)
  } catch {
    return { kind: "error", code: "trigger_detail_failed" }
  }
  const refs = extractMessageRefs(detail)
  const chatId = refs.chatId ?? launch.chatId
  if (!chatId || refs.messageIds.length === 0) {
    return { kind: "error", code: "no_messages_selected" }
  }

  const submitted = await submitLarkIntent({
    path: "/shortcut/import",
    body: {
      adapterId,
      chatId,
      messageIds: refs.messageIds,
      triggerId: launch.triggerId,
    },
    adapterId,
    returnTo: options.returnTo,
    apiBase: options.apiBase,
    fetchFn: options.fetchFn,
  })
  if (submitted.kind !== "accepted") return submitted

  const result = await pollLarkIntent({
    requestId: submitted.requestId,
    apiBase: options.apiBase,
    fetchFn: options.fetchFn,
    pollIntervalMs: options.pollIntervalMs,
    pollBudgetMs: options.pollBudgetMs,
    sleep: options.sleep,
  })
  if (result.kind === "error") return result
  const conversationKey = result.result.conversationKey
  if (typeof conversationKey !== "string" || !conversationKey) {
    return { kind: "error", code: "intent_failed" }
  }
  return {
    kind: "navigate",
    conversationKey,
    sessionId: typeof result.result.sessionId === "string" ? result.result.sessionId : undefined,
    imported: typeof result.result.imported === "number" ? result.result.imported : undefined,
  }
}
