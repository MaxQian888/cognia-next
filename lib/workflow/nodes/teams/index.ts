import { registerNodeExecutor } from "../registry"
import { createCharacter, updateCharacter } from "@/lib/db/characters"
import { createTeam, updateTeam } from "@/lib/db/teams"
import { nonRetryable } from "../shared/executor-support"
import { loadTeamWorkflowNodes } from "./team-runtime-port"

// ── action.character.create ───────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.character.create",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      name?: string
      systemPrompt?: string
      description?: string
      avatarColor?: string
      avatarEmoji?: string
      model?: string
    }
    if (!params.name?.trim()) {
      throw nonRetryable("action.character.create requires a non-empty 'name'")
    }
    if (!params.systemPrompt?.trim()) {
      throw nonRetryable("action.character.create requires a 'systemPrompt'")
    }
    const character = await createCharacter({
      name: params.name.trim(),
      systemPrompt: params.systemPrompt,
      description: params.description,
      avatarColor: params.avatarColor,
      avatarEmoji: params.avatarEmoji,
      model: params.model,
    })
    return {
      output: { characterId: character.id, name: character.name },
    }
  },
})

// ── action.character.update ───────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.character.update",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      characterId?: string
      patch?: Record<string, unknown>
    }
    const id = params.characterId?.trim()
    if (!id) {
      throw nonRetryable("action.character.update requires 'characterId'")
    }
    if (!params.patch || typeof params.patch !== "object") {
      throw nonRetryable("action.character.update requires a non-empty 'patch' object")
    }
    // Strip immutable fields the UI shouldn't be able to override.
    const {
      id: _id,
      createdAt: _ca,
      isBuiltIn: _bi,
      ...safePatch
    } = params.patch as Record<string, unknown>
    void _id
    void _ca
    void _bi
    await updateCharacter(id, safePatch as Parameters<typeof updateCharacter>[1])
    return { output: { characterId: id, patched: Object.keys(safePatch) } }
  },
})

// ── action.team.create ────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.team.create",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      name?: string
      members?: Array<{ characterId: string; role?: string }>
      orchestration?: "round_robin" | "supervisor" | "mention_round_robin"
      supervisorCharacterId?: string
      description?: string
    }
    if (!params.name?.trim()) {
      throw nonRetryable("action.team.create requires a non-empty 'name'")
    }
    if (!Array.isArray(params.members) || params.members.length === 0) {
      throw nonRetryable("action.team.create requires at least one member")
    }
    const team = await createTeam({
      name: params.name.trim(),
      description: params.description,
      members: params.members,
      orchestration: params.orchestration,
      supervisorCharacterId: params.supervisorCharacterId,
    })
    return { output: { teamId: team.id, name: team.name } }
  },
})

// ── action.team.update ────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.team.update",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      teamId?: string
      patch?: Record<string, unknown>
    }
    const id = params.teamId?.trim()
    if (!id) {
      throw nonRetryable("action.team.update requires 'teamId'")
    }
    if (!params.patch || typeof params.patch !== "object") {
      throw nonRetryable("action.team.update requires a 'patch' object")
    }
    const {
      id: _id,
      createdAt: _ca,
      isBuiltIn: _bi,
      ...safePatch
    } = params.patch as Record<string, unknown>
    void _id
    void _ca
    void _bi
    await updateTeam(id, safePatch as Parameters<typeof updateTeam>[1])
    return { output: { teamId: id, patched: Object.keys(safePatch) } }
  },
})

// ── action.agent.turn ─────────────────────────────────────────────────────
// Full tool-enabled agent turn (sidecar on desktop, honest text-only
// degradation on web). Logic in ./actions/agent-turn for testability.
// Not retryable — an agent turn can have side effects (tool calls).
registerNodeExecutor({
  kind: "action.agent.turn",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await import("../actions/agent-turn")).runAgentTurn(ctx),
})

// ── action.character.send ─────────────────────────────────────────────────
// Posts a message into a character's chat session. The session is created
// on first send if it doesn't exist. The chat UI (when open) picks up the
// new message and the AI responds normally; when the UI is closed, the
// message lands and AI response fires the next time the session is opened.
// For platform-bound (connector) sessions, prefer `action.connector.send`.
registerNodeExecutor({
  kind: "action.character.send",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      characterId?: string
      sessionId?: string
      content?: string
      role?: "user" | "assistant"
    }
    const characterId = params.characterId?.trim()
    const content = params.content ?? ""
    if (!characterId) throw nonRetryable("action.character.send requires 'characterId'")
    if (!content) throw nonRetryable("action.character.send requires non-empty 'content'")
    const role = params.role === "assistant" ? "assistant" : "user"

    const [{ getCharacter }, { listSessions, createSession }, { persistMessages, listMessages }] =
      await Promise.all([
        import("@/lib/db/characters"),
        import("@/lib/db/sessions"),
        import("@/lib/db/messages"),
      ])

    const character = await getCharacter(characterId)
    if (!character) throw nonRetryable(`character ${characterId} not found`)

    let sessionId = params.sessionId?.trim() || ""
    if (!sessionId) {
      // Re-use the most recent session for the character, or create a new one.
      const all = await listSessions()
      const matching = all.filter((s) => s.characterId === characterId)
      sessionId = matching[0]?.id ?? ""
      if (!sessionId) {
        const created = await createSession({
          title: `${character.name} (workflow)`,
          characterId,
        })
        sessionId = created.id
      }
    }

    type UIMessageLike = Parameters<typeof persistMessages>[1][number]
    const existing = await listMessages(sessionId)
    const id = `msg_wf_${ctx.runId}_${ctx.stepId}`
    const message = {
      id,
      role,
      parts: [{ type: "text" as const, text: content }],
    } as unknown as UIMessageLike
    const next: UIMessageLike[] = [...existing, message]
    await persistMessages(sessionId, next)
    return {
      output: {
        characterId,
        sessionId,
        messageId: id,
        role,
        deliveryDeferred: role === "user", // AI auto-respond requires the chat UI to be open
      },
    }
  },
})

// ── Agent Team nodes ──────────────────────────────────────────────────────
// ADR-0022 (run, task dispatch), ADR-0071 (task review), the Registry
// reconcile checkpoint, and the team surface nodes (compose / status /
// delegate / message). The implementations belong to the Agent Team
// (`lib/ai/agent/team/workflow-nodes`) and are reached through the installable
// port, so the workflow engine never imports team code (ADR-0217).
//
// Retry flags stay here, with the registration: task dispatch retries (each
// retry re-claims from the pool, rotating teammates); review, compose and
// delegate are single-shot decisions or side effects and never retry.
registerNodeExecutor({
  kind: "action.team.run",
  typeVersion: 1,
  execute: async (ctx) => (await loadTeamWorkflowNodes("action.team.run")).run(ctx),
})

registerNodeExecutor({
  kind: "action.team.task.dispatch",
  typeVersion: 1,
  retryable: true,
  execute: async (ctx) =>
    (await loadTeamWorkflowNodes("action.team.task.dispatch")).dispatchTask(ctx),
})

registerNodeExecutor({
  kind: "action.team.task.review",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await loadTeamWorkflowNodes("action.team.task.review")).reviewTask(ctx),
})

registerNodeExecutor({
  kind: "action.team.reconcile",
  typeVersion: 1,
  execute: async (ctx) => (await loadTeamWorkflowNodes("action.team.reconcile")).reconcile(ctx),
})

registerNodeExecutor({
  kind: "action.team.compose",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await loadTeamWorkflowNodes("action.team.compose")).compose(ctx),
})

registerNodeExecutor({
  kind: "action.team.status",
  typeVersion: 1,
  execute: async (ctx) => (await loadTeamWorkflowNodes("action.team.status")).status(ctx),
})

registerNodeExecutor({
  kind: "action.team.delegate",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx) => (await loadTeamWorkflowNodes("action.team.delegate")).delegate(ctx),
})

registerNodeExecutor({
  kind: "action.team.message",
  typeVersion: 1,
  execute: async (ctx) => (await loadTeamWorkflowNodes("action.team.message")).message(ctx),
})
