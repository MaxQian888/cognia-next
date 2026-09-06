/**
 * Start a conversation on a plugin's behalf, optionally seeded with a first
 * user message and switched to.
 *
 * A plugin surface that hands a task off to chat — "write this topic", "open a
 * review for this finding" — needs three things to happen together: a session
 * bound to the right character, a first message persisted into it, and the UI
 * moved there. The move is not optional for a plugin: a handoff the user does
 * not land in is a handoff they will not notice, and the SDK's own
 * `PluginSeededSessionInput` carries no flag to decline it.
 *
 * The host signature accepts one, because the host has a caller a plugin does
 * not: a workflow step. Nobody clicked anything there, so there is nobody to
 * move, and on the cloud brain there is no UI to move them to. `ctx.sessions.createSession()` only does the first, and it goes
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
import type {
  PluginSeededSessionInput,
  PluginSeededSessionResult,
} from "@cognia/plugin-sdk/api/agent-turn"

export type {
  PluginSeededSessionInput,
  PluginSeededSessionResult,
} from "@cognia/plugin-sdk/api/agent-turn"

export async function startSeededSession(
  input: PluginSeededSessionInput & { activate?: boolean } = {}
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
