/**
 * Conversation action nodes: `action.session.{create,get,list,appendMessage,
 * update,archive,export}`.
 *
 * `action.session.create` goes through `startSeededSession`, which wraps
 * `startNewSession`, and NOT through `createSession`. That distinction is the
 * whole point: `createSession` writes the Dexie row and nothing else, skipping
 * workspace attribution from the store rather than the lagging persisted
 * pointer, execution-context and managed-workspace materialization, and the
 * `session.created` bus event. A conversation a workflow started has to be the
 * same kind of object as one a person started, or every surface downstream has
 * to learn about a second shape.
 *
 * That also settles persistence and sync for the whole family with no work:
 * `sessions`, `messages` and `projects` are all already companion-synced
 * (`lib/sync/companion-sync.ts`), so a conversation minted by a scheduled run
 * reaches the user's phone through the same pipeline as every other one. No
 * schema bump, no new sync handler.
 *
 * `action.character.send` (`../teams`) is the character-addressed sibling and
 * still calls `createSession` directly. Folding it onto these two nodes is a
 * follow-up, not this change.
 *
 * There is deliberately no `action.session.delete`. An unattended graph
 * removing a conversation a person saved is a consent problem, the same one
 * `../artifacts` states for artifacts. `archive` is the reversible one.
 */

import { listMessages, persistMessages } from "@/lib/db/messages"
import {
  archiveSession,
  assignSessionToFolder,
  bulkSetSessionsPinned,
  getSession,
  listScopedSessions,
  unarchiveSession,
  updateSession,
} from "@/lib/db/sessions"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import type { ChatSession } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"
import type { StepExecutionContext } from "@/types/workflow/visual"
import { registerNodeExecutor } from "../registry"
import { nonRetryable } from "../shared/executor-support"

/** Cap on messages a single node may pull into a step output. */
const MESSAGE_LIMIT_DEFAULT = 50
const MESSAGE_LIMIT_CEILING = 500

function params(ctx: StepExecutionContext): Record<string, unknown> {
  return ctx.params as Record<string, unknown>
}

function str(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key]
  if (typeof v !== "string") return undefined
  const t = v.trim()
  return t.length > 0 ? t : undefined
}

function bool(p: Record<string, unknown>, key: string): boolean | undefined {
  return typeof p[key] === "boolean" ? (p[key] as boolean) : undefined
}

function int(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key]
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined
}

/**
 * Project a session for a step output.
 *
 * A `ChatSession` carries a working set, branch selections, a surface binding
 * and an execution context, none of which a downstream node can act on and
 * some of which name paths that mean something different on another Host.
 */
function toSessionSummary(session: ChatSession) {
  return {
    sessionId: session.id,
    title: session.title,
    kind: session.kind ?? "direct",
    projectId: session.projectId,
    characterId: session.characterId,
    teamId: session.teamId,
    folderId: session.folderId,
    pinned: session.pinned ?? false,
    archivedAt: session.archivedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }
}

/** Plain-text rendering of a message's text parts. */
function messageText(message: UIMessage): string {
  const parts = (message as { parts?: Array<{ type?: string; text?: string }> }).parts ?? []
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
}

function toMessageSummary(message: UIMessage) {
  return {
    id: message.id,
    role: message.role,
    text: messageText(message),
  }
}

/** The session this step addresses, refusing an id this Host does not hold. */
async function requireSession(ctx: StepExecutionContext, kind: string): Promise<ChatSession> {
  const sessionId = str(params(ctx), "sessionId")
  if (!sessionId) throw nonRetryable(`${kind} requires 'sessionId'`)
  const session = await getSession(sessionId)
  // ADR-0116 makes live session state host-authoritative. A step that wrote
  // optimistically into a session another Host owns would be competing with
  // that Host's turn state, so it refuses instead.
  if (!session) throw nonRetryable(`${kind}: this Host does not hold session ${sessionId}`)
  return session
}

registerNodeExecutor({
  kind: "action.session.create",
  typeVersion: 1,
  // A retry would leave a stranded empty conversation behind.
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const { startSeededSession } = await import("@/lib/plugin/api/session-seed")
    const { sessionId } = await startSeededSession({
      title: str(p, "title"),
      characterId: str(p, "characterId"),
      // The run's workspace unless the node names one. A scheduled run has no
      // open panel, so reading the UI pointer here would be an empty value
      // dressed up as an answer.
      projectId: str(p, "projectId") ?? ctx.projectId,
      workingDir: str(p, "workingDir"),
      seedUserMessage: str(p, "seedUserMessage"),
      // Nobody clicked anything, so there is nobody to move. On the brain
      // there is no UI to move them to at all.
      activate: bool(p, "activate") ?? false,
    })
    const session = await getSession(sessionId)
    return {
      output: session
        ? toSessionSummary(session)
        : { sessionId, title: str(p, "title") ?? "", pinned: false },
    }
  },
})

registerNodeExecutor({
  kind: "action.session.get",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const session = await requireSession(ctx, "action.session.get")
    const limit = Math.min(Math.max(int(p, "messageLimit") ?? 0, 0), MESSAGE_LIMIT_CEILING)
    if (limit === 0) {
      return { output: { ...toSessionSummary(session), messages: [], messageCount: 0 } }
    }
    const all = await listMessages(session.id)
    const recent = all.slice(-limit)
    return {
      output: {
        ...toSessionSummary(session),
        messages: recent.map(toMessageSummary),
        messageCount: recent.length,
        totalMessageCount: all.length,
        truncated: all.length > recent.length,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.session.list",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const scope = str(p, "projectId") ?? ctx.projectId
    const rows = await listScopedSessions(scope)
    // An embedded session belongs to a resource workbench and an imported
    // subagent transcript is reachable only by drilling in from its parent.
    // Neither is a conversation an author means when they ask to list them.
    const exposed = filterExposedSessions(rows, "plugin-enumeration")
    const includeArchived = bool(p, "includeArchived") ?? false
    const filtered = exposed.filter((s) => {
      if (!includeArchived && s.archivedAt !== undefined) return false
      const characterId = str(p, "characterId")
      if (characterId && s.characterId !== characterId) return false
      const folderId = str(p, "folderId")
      if (folderId && s.folderId !== folderId) return false
      if ((bool(p, "pinnedOnly") ?? false) && !s.pinned) return false
      return true
    })
    const limit = Math.min(Math.max(int(p, "limit") ?? 20, 1), 200)
    const page = filtered.slice(0, limit)
    return {
      output: {
        projectId: scope,
        sessions: page.map(toSessionSummary),
        sessionCount: page.length,
        totalCount: filtered.length,
        truncated: filtered.length > page.length,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.session.appendMessage",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const session = await requireSession(ctx, "action.session.appendMessage")
    const text = typeof p.text === "string" ? p.text : undefined
    if (!text?.trim()) throw nonRetryable("action.session.appendMessage requires 'text'")
    const role = p.role === "assistant" ? "assistant" : "user"

    // Read the transcript first: `persistMessages` replaces it wholesale, so
    // handing it one message would delete the conversation.
    const existing = await listMessages(session.id)
    // Deterministic id, matching `action.character.send`. A replayed step
    // writes the same message rather than a second copy of it.
    const messageId = `msg_wf_${ctx.runId}_${ctx.stepId}`
    const message = {
      id: messageId,
      role,
      parts: [{ type: "text" as const, text }],
    } as unknown as UIMessage
    await persistMessages(session.id, [...existing.filter((m) => m.id !== messageId), message])
    return {
      output: {
        sessionId: session.id,
        messageId,
        role,
        messageCount: existing.filter((m) => m.id !== messageId).length + 1,
        // A user-role message does not start a turn on its own: the chat UI
        // has to be open for auto-respond, same as `action.character.send`.
        deliveryDeferred: role === "user",
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.session.update",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const session = await requireSession(ctx, "action.session.update")
    const title = str(p, "title")
    const pinned = bool(p, "pinned")
    const hasFolder = Object.prototype.hasOwnProperty.call(p, "folderId")

    if (title === undefined && pinned === undefined && !hasFolder) {
      throw nonRetryable(
        "action.session.update requires at least one of 'title', 'pinned' or 'folderId'"
      )
    }

    // A manual rename opts the conversation out of auto-titling permanently,
    // which is what a workflow naming one means too.
    if (title !== undefined) await updateSession(session.id, { title, titleAuto: false })
    if (pinned !== undefined) await bulkSetSessionsPinned([session.id], pinned)
    if (hasFolder) {
      const folderId = str(p, "folderId")
      await assignSessionToFolder(session.id, folderId ?? null)
    }

    const updated = await getSession(session.id)
    return { output: updated ? toSessionSummary(updated) : { sessionId: session.id } }
  },
})

registerNodeExecutor({
  kind: "action.session.archive",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const session = await requireSession(ctx, "action.session.archive")
    const archived = bool(p, "archived") ?? true
    if (archived) await archiveSession(session.id)
    else await unarchiveSession(session.id)
    const updated = await getSession(session.id)
    return {
      output: {
        ...(updated ? toSessionSummary(updated) : { sessionId: session.id }),
        archived,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.session.export",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const session = await requireSession(ctx, "action.session.export")
    const messages = await listMessages(session.id)
    const format = p.format === "json" ? "json" : "markdown"

    // Serialized here rather than through `messagesToMarkdown`, which lives
    // inside a React component module (`components/ai-elements/conversation`)
    // and would drag the component graph into a headless executor.
    const content =
      format === "json"
        ? JSON.stringify(
            { session: toSessionSummary(session), messages: messages.map(toMessageSummary) },
            null,
            2
          )
        : [
            `# ${session.title}`,
            "",
            ...messages.flatMap((m) => [`## ${m.role}`, "", messageText(m), ""]),
          ].join("\n")

    return {
      output: {
        sessionId: session.id,
        title: session.title,
        format,
        content,
        messageCount: messages.length,
        byteLength: content.length,
      },
    }
  },
})
