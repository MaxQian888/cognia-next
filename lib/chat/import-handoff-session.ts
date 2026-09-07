/**
 * Import a transcript handed off from the standalone CLI into a desktop chat
 * session the user can continue.
 *
 * This is the desktop end of the CLI→app handoff. The CLI POSTs its session
 * transcript over the loopback bridge; the bridge emits an event; the renderer
 * calls this to materialise a real {@link ChatSession} + messages, then opens
 * it. It is the external-data sibling of `branchSessionAtMessage`'s direct
 * mode — the incoming turns become visible messages AND a one-shot
 * `branchSeed.transcript` re-establishes context for the first in-app send
 * (the CLI ran a separate sidecar, so there is no `sdkSessionId` to resume).
 *
 * Pure DB orchestration over `lib/db/sessions` + `lib/db/messages`, so it is
 * unit-testable with a fake-indexeddb Dexie.
 */

import type { UIMessage } from "ai"
import type { CanonicalTurn } from "@cognia/agent-config-types/canonical-session"

import type { ChatSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { persistMessages, invalidatePersistSnapshot, toStoredMessageRow } from "@/lib/db/messages"
import { resolveScopeProjectId } from "@/lib/db/project-scope"
import { renderTranscript } from "@/lib/chat/branch-session"
import { normalizeMessageMedia } from "@/lib/chat/media/normalize-message-media"
import { messageMediaRefRows } from "@/lib/db/message-media-refs"
import { markSessionDirty } from "@/lib/chat/search/indexer"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"

export interface HandoffMessage {
  role: "user" | "assistant" | "system"
  content: string
  id?: string
  parts?: UIMessage["parts"]
}

/** Restore supported structured history; unfinished tools remain interrupted history. */
export function canonicalTurnToHandoffMessage(turn: CanonicalTurn): HandoffMessage {
  const parts: UIMessage["parts"] = []
  if (turn.reasoning) parts.push({ type: "reasoning", text: turn.reasoning, state: "done" })
  if (turn.text) parts.push({ type: "text", text: turn.text })
  for (const part of turn.parts ?? []) {
    if (part.type === "file") {
      parts.push({
        type: "file",
        url: part.uri,
        filename: part.name,
        mediaType: part.mediaType ?? "application/octet-stream",
      })
    } else {
      // Canonical content types stay visible to data-part renderers without inventing runtime calls.
      parts.push({ type: "data-canonical-content", data: part })
    }
  }
  for (const call of turn.toolCalls ?? []) {
    const completed =
      call.status === "completed" ||
      (call.status === undefined && call.resultText !== undefined && !call.isError)
    parts.push(
      completed
        ? {
            type: "dynamic-tool",
            toolName: call.toolName,
            toolCallId: call.callId,
            input: call.input ?? {},
            state: "output-available",
            output: call.resultText ?? "",
          }
        : {
            type: "dynamic-tool",
            toolName: call.toolName,
            toolCallId: call.callId,
            input: call.input ?? {},
            state: "output-error",
            errorText: call.resultText ?? "thread_handoff_tool_interrupted",
          }
    )
  }
  return { id: turn.turnId, role: turn.role, content: turn.text, parts }
}

export interface ImportHandoffParams {
  /** Session id minted by the CLI (so it can report it / cross-reference). */
  sessionId: string
  title?: string
  messages: HandoffMessage[]
  /** Optional run context to seed the session row. */
  meta?: {
    provider?: string
    model?: string
    cwd?: string
  }
  /**
   * Workspace the imported session belongs to. Defaults to the active
   * workspace via {@link resolveScopeProjectId} so the row is visible in the
   * scoped chat sidebar (a raw `put` with no `projectId` is invisible to
   * `listScopedSessions`).
   */
  projectId?: string
  /**
   * Lineage marker written on the row, and the marker a pre-existing row must
   * already carry to count as an idempotent re-import rather than a native
   * collision. Defaults to the CLI handoff this module was built for; the
   * ADR-0103 cross-host receiver passes `"thread-handoff"` so its own retries
   * overwrite in place instead of diverting to a fresh id.
   */
  handoffSource?: "cli" | "thread-handoff"
  /** Target import writes its frozen ownership lock in the same transaction as history. */
  handoffLock?: ChatSession["handoffLock"]
  /** Injected clock for deterministic tests. */
  now?: number
}

function newMessageId(seed: string): string {
  return `m_${seed}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Mint a fresh session id when the CLI-supplied one collides with a native
 * (non-handoff) desktop session. Same shape as `lib/db/sessions.ts:newId`.
 */
function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function toUiMessages(messages: HandoffMessage[]): UIMessage[] {
  return messages.map(
    (m, i) =>
      ({
        id: m.id ?? newMessageId(`${i}`),
        role: m.role,
        parts: m.parts ?? [{ type: "text", text: m.content }],
      }) as UIMessage
  )
}

/**
 * Materialise a handed-off transcript as a continuable desktop session.
 * Idempotent on `sessionId` (a repeat handoff overwrites the row + messages).
 * Returns the created {@link ChatSession}.
 */
export async function importHandoffSession(params: ImportHandoffParams): Promise<ChatSession> {
  const { messages, meta } = params
  if (!params.sessionId) throw new Error("importHandoffSession: sessionId is required")

  const now = params.now ?? Date.now()
  const uiMessages = toUiMessages(messages)
  const transcript = renderTranscript(uiMessages)
  const db = getDb()

  // Collision guard: a prior handoff of the SAME session (tagged with THIS
  // import's `handoffSource`) is overwritten in place — the intended idempotent
  // re-handoff. But an incoming id that instead belongs to a *native* desktop
  // session must never be clobbered (title reset, messages replaced), so divert
  // to a fresh id and leave the original row untouched.
  const handoffSource = params.handoffSource ?? "cli"
  const existing = await db.sessions.get(params.sessionId)
  const isPriorHandoff = existing?.handoffSource === handoffSource
  const collidesWithNative = existing != null && !isPriorHandoff
  if (params.handoffLock && collidesWithNative)
    throw new Error("thread_handoff_target_session_collision")
  const sessionId = collidesWithNative ? newSessionId() : params.sessionId
  // Guard AFTER the diversion: a native collision writes a brand-new row and
  // never touches `existing`, so its handoff lock is none of this import's
  // business. Only the overwrite-in-place path needs the row to be writable.
  if (
    !collidesWithNative &&
    !(params.handoffLock && existing?.handoffLock?.ticketId === params.handoffLock.ticketId)
  )
    assertSessionWritable(existing, "metadata")

  // Workspace scope: preserve a prior handoff's workspace; otherwise stamp the
  // active one so the row shows up in the scoped chat sidebar. Without this the
  // `[projectId+updatedAt]` index skips the row and it never lists.
  const projectId =
    (isPriorHandoff ? existing?.projectId : undefined) ??
    (await resolveScopeProjectId(params.projectId))

  const session: ChatSession = {
    id: sessionId,
    projectId,
    title: params.title?.trim() || "Handoff from CLI",
    titleAuto: false,
    kind: "direct",
    // Lineage marker: distinguishes a re-handoff from a native-session collision
    // (see the collision guard above) and lets the UI show where it came from.
    handoffSource,
    model: meta?.model,
    providerOverride: meta?.provider,
    workingDir: meta?.cwd,
    // Preserve the original creation time on an idempotent re-handoff.
    createdAt: isPriorHandoff ? (existing?.createdAt ?? now) : now,
    updatedAt: now,
    // Seed the truncated context for the first in-app send (no sdkSessionId to fork).
    branchKind: "direct",
    ...(transcript ? { branchSeed: { kind: "transcript" as const, content: transcript } } : {}),
  }

  if (params.handoffLock) {
    const normalized = await Promise.all(uiMessages.map(normalizeMessageMedia))
    // Built through the shared row builder rather than by hand: `persistMessages`
    // hoists `senderId` / `senderKind` / `turnKey` / `collaboration` out of
    // metadata onto their columns, and a second writer that skipped that step
    // would store rows shaped unlike every other row in this table.
    const rows = normalized.map((message, index) =>
      toStoredMessageRow(uiMessages[index] ?? message, {
        id: `${sessionId}:${message.id}`,
        sessionId,
        projectId,
        parts: message.parts,
        createdAt: now + index,
      })
    )
    session.handoffLock = params.handoffLock
    await db.transaction("rw", db.sessions, db.messages, db.messageMediaRefs, async () => {
      await db.sessions.put(session)
      await db.messages.where("sessionId").equals(sessionId).delete()
      await db.messageMediaRefs.where("sessionId").equals(sessionId).delete()
      await db.messages.bulkPut(rows)
      const refs = rows.flatMap((row) => messageMediaRefRows(row.id, row.sessionId, row.parts))
      if (refs.length > 0) await db.messageMediaRefs.bulkPut(refs)
    })
    invalidatePersistSnapshot(sessionId)
    markSessionDirty(sessionId)
  } else {
    await db.sessions.put(session)
    invalidatePersistSnapshot(sessionId)
    await persistMessages(sessionId, uiMessages)
  }

  return session
}
