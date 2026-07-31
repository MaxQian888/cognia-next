import { createSession } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import type { ChatSession } from "@cognia/agent-config-types"

/** The subset of a session a caller may seed when starting a conversation. */
export type NewSessionInput = Partial<
  Pick<
    ChatSession,
    "title" | "model" | "systemPrompt" | "workingDir" | "kind" | "characterId" | "teamId"
  >
>

/**
 * The single path that starts a conversation. Every entry point — welcome CTA,
 * starter cards, channel-list "+", command palette, native menu / Cmd+N, tray,
 * CLI `--new-chat` — funnels through here so "new chat" means one thing.
 *
 * Beyond writing the Dexie row it owns the three side effects that a session is
 * useless without: workspace linking (else the session is invisible in the
 * scoped list), activation, and the plugin-bus announcement.
 *
 * Passing no input is the deliberate "quick start" path: `createSession`
 * auto-applies the default preset when no character/team/model/prompt/dir is
 * given, so a conversation is usable without picking a character first.
 */
export async function startNewSession(partial?: NewSessionInput): Promise<ChatSession> {
  const session = await createSession(partial)

  // Auto-link to the active workspace so it groups under that project
  // (persisted via `project.sessionIds`). No-op when no workspace is active.
  const { activeProjectId, addSessionToProject } = useProjectStore.getState()
  if (activeProjectId) addSessionToProject(activeProjectId, session.id)

  useChatStore.getState().setActiveSession(session.id)
  emitSystemBusEvent(SystemEvents.SESSION_CREATED, { sessionId: session.id })

  return session
}
