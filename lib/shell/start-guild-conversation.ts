/**
 * Start — or switch to — a conversation from the shell chrome.
 *
 * The conversation rail already has the workspace's own handlers threaded
 * through it (`desktop-chat-workspace.tsx` → `ChannelList`), but the 56px icon
 * column is mounted by `DesktopAppShell` on *every* route, where no chat
 * workspace exists — so its guild menus need a path that works from `/inbox`
 * as well as from `/`. This is that path, and it is deliberately thin: it
 * reuses `startNewSession` (the single documented way a conversation is
 * created, with its workspace linking / activation / bus announcement) rather
 * than growing a second one.
 *
 * The guild is selected *before* the session is created so the list the user
 * lands on is the one the new conversation belongs to.
 */

import { startNewSession } from "@/lib/chat/start-session"
import { listScopedSessions } from "@/lib/db/sessions"
import { isSessionExposed } from "@/lib/chat/session-exposure"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import { useChatStore } from "@/stores/chat"
import { useUIStore } from "@/stores/ui"
import { loggers } from "@cognia/logging"
import type { ChatSession } from "@cognia/agent-config-types"

const log = loggers.ui

interface StartGuildConversationNavigationOptions {
  /** Called with `/` when the caller has to leave the route it is on. */
  navigate?: (route: string) => void
  /** Current route — no navigation happens when already home. */
  pathname?: string
}

export type StartGuildConversationOptions = StartGuildConversationNavigationOptions &
  (
    | {
        /** `null` (or omitted) starts a direct conversation. */
        teamId?: null
        teamTitle?: never
      }
    | {
        teamId: string
        /** Localized by the UI caller before the persisted session is created. */
        teamTitle: string
      }
  )

export async function startGuildConversation(
  options: StartGuildConversationOptions = {}
): Promise<ChatSession> {
  const { teamId = null, teamTitle, navigate, pathname } = options
  if (teamId && !teamTitle) {
    throw new Error("teamTitle is required for team conversations")
  }
  log.info("shell start guild conversation", { teamId })
  useUIStore.getState().setSelectedGuild(teamId ? { kind: "team", teamId } : { kind: "dm" })
  const session = await startNewSession(
    teamId ? { title: teamTitle, kind: "team", teamId } : undefined
  )
  useChatStore.getState().setActiveSession(session.id)
  emitSystemBusEvent(SystemEvents.SESSION_SWITCHED, { sessionId: session.id })
  if (navigate && pathname !== "/") navigate("/")
  return session
}

export type OpenCharacterChatOptions = StartGuildConversationNavigationOptions & {
  /** Title for a conversation that has to be created; localized by the caller. */
  newChatTitle: string
}

/**
 * Open the one-to-one conversation with a character — "switch to this
 * member's chat" on the team-members panel, and the same thing any other
 * surface holding a `Character` needs.
 *
 * Switch first, create second. A character the user has talked to already has
 * a conversation, and always starting a fresh one would bury the history under
 * a pile of empty chats named after the same persona. The newest *direct*
 * conversation bound to this character in the current workspace wins;
 * archived rows are eligible (they are the history the user is asking for, and
 * activating one is how you get back to it), embedded ones are not — a
 * sidechat or a subagent thread is not a conversation you can navigate to.
 *
 * `startNewSession` already activates and announces what it creates, so only
 * the switch branch has to do that itself.
 */
export async function openCharacterChat(
  character: { id: string; name: string },
  options: OpenCharacterChatOptions
): Promise<ChatSession> {
  const { newChatTitle, navigate, pathname } = options
  const scoped = await listScopedSessions()
  // `listScopedSessions` is already newest-first, so the first hit is the one.
  const existing = scoped.find(
    (session) =>
      session.characterId === character.id &&
      (session.kind ?? "direct") === "direct" &&
      isSessionExposed(session, "main-list")
  )
  log.info("shell open character chat", {
    characterId: character.id,
    reused: Boolean(existing),
  })
  useUIStore.getState().setSelectedGuild({ kind: "dm" })
  const session =
    existing ??
    (await startNewSession({ title: newChatTitle, kind: "direct", characterId: character.id }))
  if (existing) {
    useChatStore.getState().setActiveSession(existing.id)
    emitSystemBusEvent(SystemEvents.SESSION_SWITCHED, { sessionId: existing.id })
  }
  if (navigate && pathname !== "/") navigate("/")
  return session
}
