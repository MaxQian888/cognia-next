/**
 * Start a conversation on a plugin's behalf, optionally seeded with a first
 * user message and switched to.
 *
 * A plugin surface that hands a task off to chat — "write this topic", "open a
 * review for this finding" — needs three things to happen together: a session
 * bound to the right character, a first message persisted into it, and the UI
 * moved there. The move is not optional and there is no flag for it:
 * `startNewSession()` activates unconditionally, and a handoff the user does
 * not land in is a handoff they will not notice. `ctx.sessions.createSession()` only does the first, and it goes
 * straight to Dexie, skipping everything `startNewSession()` does around it:
 * workspace attribution from the STORE rather than the lagging persisted
 * pointer, execution-context and managed-workspace materialization, and the
 * `session.created` bus event other plugins listen for.
 *
 * So this wraps the host's own entry point instead of a second, thinner copy
 * of it. That is the whole point: a plugin-started conversation and a
 * user-started one must be the same kind of object.
 */

import type { UIMessage } from "ai"

export interface PluginSeededSessionInput {
  title?: string
  /** Persona the conversation runs as. */
  characterId?: string
  /** Workspace the conversation belongs to; omitted means the active one. */
  projectId?: string
  /** Absolute path the conversation's turns run in. */
  workingDir?: string
  /**
   * First user message. Persisted into the transcript before the session is
   * shown, so the conversation opens with the instruction already in it.
   */
  seedUserMessage?: string
}

export interface PluginSeededSessionResult {
  sessionId: string
}

export async function startSeededSession(
  input: PluginSeededSessionInput = {}
): Promise<PluginSeededSessionResult> {
  const { seedUserMessage, ...seed } = input
  const { startNewSession } = await import("@/lib/chat/start-session")
  const session = await startNewSession(seed)

  if (seedUserMessage?.trim()) {
    const [{ persistMessages }, { makeUserMessage }] = await Promise.all([
      import("@/lib/db/messages"),
      import("@/lib/claude/adapter"),
    ])
    await persistMessages(session.id, [makeUserMessage(seedUserMessage) as UIMessage])
  }

  return { sessionId: session.id }
}
