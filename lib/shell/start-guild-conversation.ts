/**
 * Start a conversation in a named guild from the shell chrome.
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
