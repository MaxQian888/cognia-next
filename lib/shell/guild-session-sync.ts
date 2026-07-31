import type { ChatSession } from "@cognia/agent-config-types"
import type { SelectedGuild } from "@/stores/ui"
import { guildFromSession } from "@/lib/claude/guild"

/**
 * Keeps the desktop chat pane's active session in lockstep with the selected
 * guild. The two are stored independently (guild in `useUIStore`, active
 * session in `useChatStore`), so when they disagree something has to reconcile
 * them — and which one wins depends on which the user touched most recently.
 *
 * This module is the pure decision layer: it computes WHAT to do from a
 * snapshot. The desktop workspace owns the side effects (select / create / etc).
 */

/** Stable identity for a guild, used to detect guild changes across renders. */
export function guildKeyOf(g: SelectedGuild): string {
  return g.kind === "team" ? `team:${g.teamId}` : g.kind
}

/** Whether a session belongs to the bucket the given guild displays. */
export function sessionMatchesGuild(s: ChatSession, g: SelectedGuild): boolean {
  if (g.kind === "team") return s.kind === "team" && s.teamId === g.teamId
  // The DM bucket holds everything that isn't a team session. Workflow-editor
  // sessions are scoped to the editor's chat tab, and `subagent` sessions
  // (ADR-0062) are hidden imported-subagent transcripts — neither surfaces here.
  return s.kind !== "team" && s.kind !== "workflow-editor" && s.kind !== "subagent"
}

/** The most recently updated session that belongs to the guild, or null. */
export function latestMatchingSession(
  sessions: readonly ChatSession[],
  g: SelectedGuild
): ChatSession | null {
  let best: ChatSession | null = null
  for (const s of sessions) {
    if (!sessionMatchesGuild(s, g)) continue
    if (!best || (s.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = s
  }
  return best
}

export type GuildReconcileAction =
  | { type: "none" }
  | { type: "select"; sessionId: string }
  | { type: "clear" }
  | { type: "sync-guild"; guild: SelectedGuild }

/**
 * Decide how to reconcile the active chat session with the selected guild.
 *
 * `guildWins` is true when the guild was chosen more recently than the active
 * session (the user clicked a team / DM in the rail) and false when the session
 * was chosen more recently (resume, fork, deletion, cold start). That recency
 * ordering is what lets a deliberate team click win over a stale active session
 * while a resumed session still pulls the guild over to match it.
 *
 * - guild wins, has a conversation  → resume the most recent matching one
 * - guild wins, has none             → clear the active session (show welcome;
 *   the CTA / "+" create a conversation explicitly — never silently here)
 * - session wins, has active session → move the guild to that session's bucket
 * - session wins, active was cleared → resume a sibling in the current guild
 */
export function planGuildReconcile(args: {
  guild: SelectedGuild
  guildWins: boolean
  activeSession: ChatSession | null
  /**
   * True while the active session id has not been resolved to a row yet.
   *
   * Every rule below reads `activeSession === null` as "no conversation is
   * open". That only holds once the id has actually been looked up: a
   * conversation that was just created — new chat, branch, fork — is the active
   * one for a full render before the session list emits its row, and treating
   * that window as "no conversation is open" redirected the user straight back
   * to the previous conversation.
   */
  activeSessionPending?: boolean
  sessions: readonly ChatSession[]
}): GuildReconcileAction {
  const { guild, guildWins, activeSession, activeSessionPending, sessions } = args

  // Canvas / plugin-view guilds render their own panes — never touch sessions.
  if (guild.kind !== "dm" && guild.kind !== "team") return { type: "none" }

  // Unknown active session: wait for the lookup rather than guess.
  if (activeSessionPending) return { type: "none" }

  const belongs = activeSession ? sessionMatchesGuild(activeSession, guild) : false
  if (belongs) return { type: "none" }

  if (guildWins) {
    const resume = latestMatchingSession(sessions, guild)
    if (resume) return { type: "select", sessionId: resume.id }
    // Nothing to show (DM or team): clear so the welcome renders (no-op if
    // already cleared, which avoids a redundant store write).
    return activeSession ? { type: "clear" } : { type: "none" }
  }

  // Session wins.
  if (activeSession) return { type: "sync-guild", guild: guildFromSession(activeSession) }
  const sibling = latestMatchingSession(sessions, guild)
  return sibling ? { type: "select", sessionId: sibling.id } : { type: "none" }
}
