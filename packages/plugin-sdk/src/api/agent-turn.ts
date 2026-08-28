/**
 * Plugin SDK — `agent-turn` capability surface.
 *
 * `ctx.agent` dispatches subagents and invokes host tools. It cannot run a full
 * CHARACTER turn: resolve a persona, pin it to a working directory, drive the
 * sidecar with that character's tool set and wait for the reply. That is the
 * only path that actually edits code, and assembling it by hand meant reaching
 * into five host-private modules — one of which hands over the entire settings
 * row, credentials included.
 *
 * `runPluginAgentTurn()` is that sequence as one call, with `AppSettings` kept
 * host-side. Read the permission note on the implementation before passing
 * `permissionMode`: a headless turn has no UI to answer a prompt, but widening
 * the posture belongs at the call site, not on the character — a character's
 * own `permissionMode` is consulted for every interactive chat with it too.
 */

export { PluginAgentTurnError, runPluginAgentTurn } from "@/lib/plugin/api/agent-turn"

export type { PluginAgentTurnRequest, PluginAgentTurnResult } from "@/lib/plugin/api/agent-turn"

/**
 * Hand a task off to a NEW conversation: a session bound to a character, a
 * first user message already in it, and the UI moved there.
 *
 * `ctx.sessions.createSession()` only creates the row — it goes straight to
 * Dexie and skips everything the host does around a real "new chat": workspace
 * attribution from the live store rather than the lagging persisted pointer,
 * execution-context and managed-workspace materialization, and the
 * `session.created` bus event other plugins listen for. A plugin-started
 * conversation has to be the same kind of object as a user-started one.
 */
export { startSeededSession } from "@/lib/plugin/api/session-seed"

export type {
  PluginSeededSessionInput,
  PluginSeededSessionResult,
} from "@/lib/plugin/api/session-seed"
