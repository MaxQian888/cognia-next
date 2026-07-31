import type { ChatSession } from "@cognia/agent-config-types"
import type { SelectedGuild } from "@/stores/ui"

/**
 * Derive the guild filter that should be active when a given session is open.
 * Used by the desktop shell to switch the rail when a session is opened from
 * the command palette, and by `app/page.tsx` for the same purpose.
 *
 * - team session with `teamId` → that team's guild
 * - everything else → the synthetic Direct Messages bucket
 */
export function guildFromSession(
  session: { kind?: string; teamId?: string | null } | ChatSession | null | undefined
): SelectedGuild {
  if (!session) return { kind: "dm" }
  if (session.kind === "team" && session.teamId) {
    return { kind: "team", teamId: session.teamId }
  }
  return { kind: "dm" }
}
