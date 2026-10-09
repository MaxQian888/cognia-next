/**
 * The lifecycle of a "Build with AI" conversation (ADR-0220).
 *
 * A builder conversation is an ordinary chat session of kind
 * `"agent-builder"`, embedded (never listed), carrying the draft it builds in
 * `agentBuilder`. Setup reuses one pristine session (no messages, empty draft)
 * instead of minting a new one per visit, so opening and leaving the builder
 * leaves nothing behind; a session with a message or a draft field is an
 * unfinished draft the person can resume or discard.
 *
 * Draft writes are read-modify-write in one transaction and bump `revision`,
 * tagged with who wrote them, so the panel and the builder's tools never
 * overwrite each other blindly.
 */

import type {
  AgentBuilderDraft,
  AgentBuilderSessionState,
  Character,
  ChatSession,
} from "@cognia/agent-config-types"
import { getDb, withDbReopenRetry } from "@/lib/db/schema"
import { updateSession } from "@/lib/db/sessions"
import { createCharacter } from "@/lib/db/characters"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"
import {
  characterToEditorState,
  editorStateToOutput,
  validateEditorState,
} from "@/lib/agents/editor-state"
import { isDraftEmpty } from "./draft-ops"

export const AGENT_BUILDER_SESSION_KIND = "agent-builder" as const

export function isAgentBuilderSession(
  session: Pick<ChatSession, "kind"> | undefined | null
): boolean {
  return session?.kind === AGENT_BUILDER_SESSION_KIND
}

export function emptyBuilderState(now: number): AgentBuilderSessionState {
  return { draft: {}, revision: 0, editedBy: "user", status: "drafting", updatedAt: now }
}

async function messageCount(sessionId: string): Promise<number> {
  return getDb().messages.where("sessionId").equals(sessionId).count()
}

/** A drafting session nobody has written into: no messages, empty draft. */
export async function isPristineBuilderSession(session: ChatSession): Promise<boolean> {
  const state = session.agentBuilder
  if (!isAgentBuilderSession(session) || !state || state.status !== "drafting") return false
  if (!isDraftEmpty(state.draft)) return false
  return (await messageCount(session.id)) === 0
}

async function builderSessions(): Promise<ChatSession[]> {
  return getDb().sessions.where("kind").equals(AGENT_BUILDER_SESSION_KIND).toArray()
}

/**
 * Unfinished drafts, newest first: drafting builder sessions with something
 * in them. A builder row synced from another device arrives without its
 * (device-local) draft state and is not a draft here.
 */
export async function listBuilderDrafts(): Promise<ChatSession[]> {
  const rows = await builderSessions()
  const drafts: ChatSession[] = []
  for (const row of rows) {
    if (!row.agentBuilder || row.agentBuilder.status !== "drafting" || row.archivedAt) continue
    if (await isPristineBuilderSession(row)) continue
    drafts.push(row)
  }
  return drafts.sort((a, b) => (b.agentBuilder?.updatedAt ?? 0) - (a.agentBuilder?.updatedAt ?? 0))
}

export interface EnsureSetupSessionDeps {
  /** The single new-chat path, with its workspace binding. */
  startSession: (input: {
    title: string
    kind: typeof AGENT_BUILDER_SESSION_KIND
    activate: false
    rememberChoice: false
  }) => Promise<ChatSession>
  now: () => number
}

let setupInFlight: Promise<ChatSession> | null = null

/**
 * The session the setup step's runtime and model pickers bind to. Concurrent
 * callers (a double-mounted effect, two tabs of the console) share one call,
 * so they cannot each mint a pristine session.
 */
export function ensureSetupBuilderSession(
  title: string,
  deps: EnsureSetupSessionDeps
): Promise<ChatSession> {
  setupInFlight ??= findOrCreateSetupSession(title, deps).finally(() => {
    setupInFlight = null
  })
  return setupInFlight
}

async function findOrCreateSetupSession(
  title: string,
  deps: EnsureSetupSessionDeps
): Promise<ChatSession> {
  for (const row of await builderSessions()) {
    if (await isPristineBuilderSession(row)) return row
  }
  const session = await deps.startSession({
    title,
    kind: AGENT_BUILDER_SESSION_KIND,
    activate: false,
    rememberChoice: false,
  })
  const agentBuilder = emptyBuilderState(deps.now())
  await updateSession(session.id, { visibility: "embedded", titleAuto: false, agentBuilder })
  return { ...session, visibility: "embedded", titleAuto: false, agentBuilder }
}

export class AgentBuilderSessionError extends Error {
  constructor(
    readonly code: "not-a-builder" | "already-created" | "invalid-draft",
    message: string
  ) {
    super(message)
    this.name = "AgentBuilderSessionError"
  }
}

export interface WriteBuilderDraftOptions {
  /**
   * The revision a person's edit was made on top of. When the builder has
   * written since (a newer revision whose last editor is the agent), the edit
   * is stale: the panel already shows the builder's version, so writing the
   * older edit would leave storage disagreeing with the screen. A stale edit
   * is dropped and the stored state returned unchanged.
   */
  baseRevision?: number
}

/**
 * Rewrite the draft of `sessionId` through `update`, atomically. Refuses a
 * session that is not a builder, and a draft whose agent was already created.
 */
export async function writeBuilderDraft(
  sessionId: string,
  update: (draft: AgentBuilderDraft) => AgentBuilderDraft,
  editedBy: AgentBuilderSessionState["editedBy"],
  options: WriteBuilderDraftOptions = {}
): Promise<AgentBuilderSessionState> {
  return withDbReopenRetry(async () => {
    const db = getDb()
    return db.transaction("rw", db.sessions, async () => {
      const session = await db.sessions.get(sessionId)
      assertSessionWritable(session, "metadata")
      if (!session || !isAgentBuilderSession(session) || !session.agentBuilder) {
        throw new AgentBuilderSessionError(
          "not-a-builder",
          "This conversation is not building an agent."
        )
      }
      if (session.agentBuilder.status === "created") {
        throw new AgentBuilderSessionError(
          "already-created",
          "This draft was already created as an agent."
        )
      }
      const current = session.agentBuilder
      if (
        options.baseRevision !== undefined &&
        current.revision > options.baseRevision &&
        current.editedBy === "agent"
      ) {
        return current
      }
      const now = Date.now()
      const next: AgentBuilderSessionState = {
        ...session.agentBuilder,
        draft: update(session.agentBuilder.draft),
        revision: session.agentBuilder.revision + 1,
        editedBy,
        updatedAt: now,
      }
      await db.sessions.update(sessionId, { agentBuilder: next, updatedAt: now })
      return next
    })
  })
}

/**
 * Turn the draft into an agent. Validates with the editor's rules, creates the
 * `Character`, and marks the conversation created so it stops being a draft.
 * The created agent keeps the runtime the draft names.
 */
export async function createAgentFromBuilder(sessionId: string): Promise<Character> {
  const session = await getDb().sessions.get(sessionId)
  if (!session || !isAgentBuilderSession(session) || !session.agentBuilder) {
    throw new AgentBuilderSessionError(
      "not-a-builder",
      "This conversation is not building an agent."
    )
  }
  if (session.agentBuilder.status === "created") {
    throw new AgentBuilderSessionError(
      "already-created",
      "This draft was already created as an agent."
    )
  }
  const state = characterToEditorState(session.agentBuilder.draft)
  const issue = validateEditorState(state)
  if (issue) {
    throw new AgentBuilderSessionError("invalid-draft", `The draft is not ready: ${issue.code}.`)
  }
  const character = await createCharacter(editorStateToOutput(state))
  await markBuilderCreated(sessionId, character.id)
  return character
}

export async function markBuilderCreated(sessionId: string, characterId: string): Promise<void> {
  const session = await getDb().sessions.get(sessionId)
  if (!session?.agentBuilder) return
  await updateSession(sessionId, {
    agentBuilder: {
      ...session.agentBuilder,
      status: "created",
      createdCharacterId: characterId,
      updatedAt: Date.now(),
    },
  })
}
