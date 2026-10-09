/**
 * Continue an agent's own (native) session as a Cognia conversation.
 *
 * The External Agents dialog lists the sessions an agent keeps on its side —
 * Codex threads, Pi sessions, ACP `session/list` entries. Resuming one inside
 * the dialog used to change nothing the user could see: the session went live
 * on the agent, and no conversation pointed at it. This is the step that was
 * missing. It makes the session live, gives it a conversation, and binds the
 * two the same way a turn does, so the conversation's next message continues
 * the agent's context instead of opening a fresh session.
 *
 * The binding is process-local on purpose, exactly like the one a turn writes:
 * a native session id names state inside one agent process, and the row only
 * ever persists gateway task links (see `persistExternalSession` in
 * `use-claude-chat-controller.ts`). Earlier turns stay in the agent; the
 * conversation starts with no Cognia-side transcript.
 */

import type { ExternalSessionLink } from "@/stores/agent/agent-runtime-store"

/** One row of the agent's session list, as `listSessions` returns it. */
export interface NativeSessionEntry {
  sessionId: string
  title?: string
  cwd?: string
  additionalDirectories?: string[]
}

export interface OpenNativeSessionInChatDeps {
  /** True when the agent already holds this session open in this process. */
  isLive: (agentId: string, nativeSessionId: string) => boolean
  /**
   * Make the session live on the agent. The caller's own resume, so whatever
   * view drives it (the dialog's active session) follows along.
   */
  resume: (
    nativeSessionId: string,
    options?: { cwd: string; additionalDirectories?: string[] }
  ) => Promise<{ id: string }>
  /** Conversation that already continues this session in this process, if any. */
  findChat: (agentId: string, nativeSessionId: string) => Promise<string | null>
  startChat: (seed: { title?: string; workingDir?: string }) => Promise<{ id: string }>
  /** Pin the conversation's runtime lane to this agent. */
  setRuntime: (chatSessionId: string, agentId: string) => void
  setLink: (chatSessionId: string, link: ExternalSessionLink) => void
  /** Stamp the manager's conversation marker on the live session. */
  bind: (agentId: string, nativeSessionId: string, chatSessionId: string) => boolean
}

export interface OpenNativeSessionInChatResult {
  chatSessionId: string
  /** The session id the agent answered with; a resume may mint a new one. */
  nativeSessionId: string
  /** An existing conversation was focused instead of creating one. */
  reused: boolean
}

export class NativeSessionBindError extends Error {
  constructor(readonly nativeSessionId: string) {
    super(`Native session "${nativeSessionId}" is not live on the agent after resume`)
    this.name = "NativeSessionBindError"
  }
}

export async function openNativeSessionInChat(
  agentId: string,
  entry: NativeSessionEntry,
  deps: OpenNativeSessionInChatDeps
): Promise<OpenNativeSessionInChatResult> {
  // Resume before any conversation exists: a resume the agent refuses must not
  // leave an empty conversation behind in the list.
  const nativeSessionId = deps.isLive(agentId, entry.sessionId)
    ? entry.sessionId
    : (
        await deps.resume(
          entry.sessionId,
          entry.cwd
            ? { cwd: entry.cwd, additionalDirectories: entry.additionalDirectories }
            : undefined
        )
      ).id

  const existing =
    (await deps.findChat(agentId, nativeSessionId)) ??
    (nativeSessionId !== entry.sessionId ? await deps.findChat(agentId, entry.sessionId) : null)
  const chatSessionId =
    existing ??
    (
      await deps.startChat({
        ...(entry.title?.trim() ? { title: entry.title.trim() } : {}),
        ...(entry.cwd ? { workingDir: entry.cwd } : {}),
      })
    ).id

  // Lane first: the store refuses a link that does not match the lane the
  // conversation runs on, which for a brand-new conversation is the default.
  deps.setRuntime(chatSessionId, agentId)
  if (!deps.bind(agentId, nativeSessionId, chatSessionId)) {
    throw new NativeSessionBindError(nativeSessionId)
  }
  deps.setLink(chatSessionId, { agentId, sessionId: nativeSessionId })
  return { chatSessionId, nativeSessionId, reused: existing !== null }
}

/**
 * Production wiring. `resume` stays the caller's, because the hook that owns
 * the dialog's active session has to see the resume happen.
 */
export async function createOpenNativeSessionInChatDeps(
  resume: OpenNativeSessionInChatDeps["resume"]
): Promise<OpenNativeSessionInChatDeps> {
  const [{ getExternalAgentManager }, { useAgentRuntimeStore }, { startNewSession }, db] =
    await Promise.all([
      import("@/lib/ai/agent/external/manager"),
      import("@/stores/agent/agent-runtime-store"),
      import("@/lib/chat/start-session"),
      import("@/lib/db/sessions"),
    ])
  const manager = getExternalAgentManager()
  return {
    isLive: (agentId, nativeSessionId) =>
      manager.liveSessions(agentId).some((session) => session.id === nativeSessionId),
    resume,
    findChat: async (agentId, nativeSessionId) => {
      const candidates: string[] = []
      const marker = manager.getSession(agentId, nativeSessionId)?.metadata?.cogniaSessionId
      if (typeof marker === "string") candidates.push(marker)
      for (const [chatId, link] of Object.entries(
        useAgentRuntimeStore.getState().sessionExternalLinks
      )) {
        if (!link.host && link.agentId === agentId && link.sessionId === nativeSessionId)
          candidates.push(chatId)
      }
      // A marker can outlive the conversation it names (deleted since).
      for (const chatId of candidates) {
        if (await db.getSession(chatId)) return chatId
      }
      return null
    },
    startChat: (seed) => startNewSession(seed),
    setRuntime: (chatSessionId, agentId) =>
      useAgentRuntimeStore.getState().setSessionRuntimeRef(chatSessionId, {
        kind: "external",
        agentId,
      }),
    setLink: (chatSessionId, link) =>
      useAgentRuntimeStore.getState().setSessionExternalLink(chatSessionId, link),
    bind: (agentId, nativeSessionId, chatSessionId) =>
      manager.bindSessionToConversation(agentId, nativeSessionId, chatSessionId),
  }
}
