/**
 * Which assistant message a `terminal_dock_*` tool call belongs to.
 *
 * The plugin-tool wire carries only a session id (see
 * `lib/claude/plugin-tool-ipc.ts` — the request shape crosses the sidecar
 * boundary), so the message id is not available where the spawn happens. It is
 * inferred renderer-side instead: a tool call is emitted *by* an assistant
 * message, and that message is the one currently being streamed into, i.e. the
 * last assistant message in the session.
 *
 * Deliberately not threaded through the wire protocol: doing so would touch the
 * sidecar↔renderer contract and every plugin-tool call site, to buy exactness in
 * a case where being one message out still lands the user on the right part of
 * the conversation.
 *
 * Returns null when it cannot tell — a spawn from a session with no assistant
 * turn yet (a slash command, a workflow trigger), where guessing would be worse
 * than offering session-level navigation.
 */

export interface SpawnerMessageLookup {
  sessions: Record<string, { messages: readonly { id: string; role: string }[] } | undefined>
  activeSessionId: string | null
  messages: readonly { id: string; role: string }[]
}

export function lastAssistantMessageId(
  state: SpawnerMessageLookup,
  sessionId: string | null | undefined
): string | null {
  if (!sessionId) return null
  // Prefer the session's own slice. The top-level `messages` projection is the
  // ACTIVE pane's, which in split view (or a background agent run) is a
  // different conversation entirely.
  const messages =
    state.sessions[sessionId]?.messages ??
    (sessionId === state.activeSessionId ? state.messages : undefined)
  if (!messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === "assistant") return message.id
  }
  return null
}
