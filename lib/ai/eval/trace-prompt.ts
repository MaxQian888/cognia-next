/**
 * Recover the ORIGINAL user prompt behind a trace.
 *
 * A {@link import("./trace-summary").TraceSummary}'s `preview` is a span's
 * `inputPreview`: PII-gated and truncated for display. Promoting a trace into
 * an eval case used it verbatim as the case input, so every case built from
 * real traffic was a clipped fragment of what the user actually asked — and
 * then the agent was evaluated against that fragment.
 *
 * The full text is still in the session's message log, so resolve from there
 * and keep the preview only as a fallback (a session whose messages were
 * cleared, or a trace with no session).
 *
 * Pure over an injected loader so it stays testable and Dexie-free;
 * {@link defaultPromptLoader} wires the real message store.
 */

import type { TraceSummary } from "./trace-summary"

/** Loads a session's messages, oldest-first. */
export type SessionMessageLoader = (
  sessionId: string
) => Promise<{ role?: string; parts?: unknown[] }[]>

/** Concatenate the text parts of an AI-SDK UI message. */
function messageText(message: { parts?: unknown[] }): string {
  if (!Array.isArray(message.parts)) return ""
  return message.parts
    .map((part) =>
      part && typeof part === "object" && (part as { type?: string }).type === "text"
        ? ((part as { text?: unknown }).text ?? "")
        : ""
    )
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join("\n")
    .trim()
}

/**
 * The first user message of `sessionId`, or `undefined` when it cannot be
 * recovered. Never throws — a missing session is a fallback, not a failure.
 */
export async function resolveTracePrompt(
  sessionId: string,
  load: SessionMessageLoader
): Promise<string | undefined> {
  if (!sessionId) return undefined
  let messages: { role?: string; parts?: unknown[] }[]
  try {
    messages = await load(sessionId)
  } catch {
    return undefined
  }
  for (const message of messages) {
    if (message.role !== "user") continue
    const text = messageText(message)
    if (text) return text
  }
  return undefined
}

/**
 * Resolve prompts for many traces at once, keyed by trace id. Sessions are
 * loaded once even when several traces share one.
 */
export async function resolveTracePrompts(
  summaries: Pick<TraceSummary, "traceId" | "sessionId">[],
  load: SessionMessageLoader
): Promise<Record<string, string>> {
  const bySession = new Map<string, string[]>()
  for (const s of summaries) {
    if (!s.sessionId) continue
    const list = bySession.get(s.sessionId) ?? []
    list.push(s.traceId)
    bySession.set(s.sessionId, list)
  }
  const out: Record<string, string> = {}
  await Promise.all(
    [...bySession].map(async ([sessionId, traceIds]) => {
      const prompt = await resolveTracePrompt(sessionId, load)
      if (!prompt) return
      for (const traceId of traceIds) out[traceId] = prompt
    })
  )
  return out
}

/** Wire the real message store. */
export function defaultPromptLoader(): SessionMessageLoader {
  return async (sessionId) => {
    const { listMessages } = await import("@/lib/db/messages")
    return (await listMessages(sessionId)) as { role?: string; parts?: unknown[] }[]
  }
}
