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
import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex } from "@noble/hashes/utils"
import type { CanonicalSession, CanonicalTurn } from "@cognia/agent-config-types/canonical-session"

import type { ChatSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import { invalidatePersistSnapshot, toStoredMessageRow } from "@/lib/db/messages"
import { resolveScopeProjectId } from "@/lib/db/project-scope"
import { buildHandoffContext } from "@/lib/chat/handoff-context"
import { normalizeMessageMedia } from "@/lib/chat/media/normalize-message-media"
import { messageMediaRefRows } from "@/lib/db/message-media-refs"
import { markSessionDirty } from "@/lib/chat/search/indexer"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"

export interface HandoffMessage {
  role: "user" | "assistant" | "system"
  content: string
  id?: string
  parts?: UIMessage["parts"]
  metadata?: UIMessage["metadata"]
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
      !call.isError &&
      (call.status === "completed" || (call.status === undefined && call.resultText !== undefined))
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
  /** Historical data only; approvals and recorded executable events are excluded. */
  historicalState?: Pick<
    CanonicalSession,
    "goals" | "tasks" | "plans" | "checkpoints" | "history" | "interAgentMessages"
  >
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
        metadata: m.metadata,
      }) as UIMessage
  )
}

/**
 * Materialise a handed-off transcript as a continuable desktop session.
 * Identical CLI snapshots reopen their durable receipt; changed snapshots fork.
 * Returns the created {@link ChatSession}.
 */
export async function importHandoffSession(params: ImportHandoffParams): Promise<ChatSession> {
  const { messages, meta } = params
  if (typeof params.sessionId !== "string" || !params.sessionId.trim())
    throw new Error("importHandoffSession: sessionId is required")

  if (
    !Array.isArray(messages) ||
    messages.some(
      (m) =>
        !m ||
        !["user", "assistant", "system"].includes(m.role) ||
        typeof m.content !== "string" ||
        (m.parts !== undefined &&
          (!Array.isArray(m.parts) || m.parts.some((p) => !p || typeof p.type !== "string")))
    )
  )
    throw new Error("importHandoffSession: invalid messages")

  if (
    (params.title !== undefined && typeof params.title !== "string") ||
    (meta !== undefined &&
      (!meta ||
        typeof meta !== "object" ||
        [meta.provider, meta.model, meta.cwd].some(
          (v) => v !== undefined && typeof v !== "string"
        )))
  ) {
    throw new Error("importHandoffSession: invalid metadata")
  }
  const suppliedIds = messages.flatMap((m) => (m.id === undefined ? [] : [m.id]))
  if (
    suppliedIds.some((id) => typeof id !== "string" || !id.trim()) ||
    new Set(suppliedIds).size !== suppliedIds.length
  ) {
    throw new Error("importHandoffSession: invalid message ids")
  }
  const now = params.now ?? Date.now()
  const uiMessages = toUiMessages(messages)
  const historicalState = params.historicalState
    ? (Object.fromEntries(
        (["goals", "tasks", "plans", "checkpoints", "history", "interAgentMessages"] as const)
          .filter((key) => params.historicalState?.[key] !== undefined)
          .map((key) => [key, params.historicalState![key]])
      ) as ImportHandoffParams["historicalState"])
    : undefined
  const context = buildHandoffContext(uiMessages, { state: historicalState })
  const transcript = context.text
  const db = getDb()

  // Keep CLI snapshots immutable across retries and continuation. Cross-host
  // handoffs retain their ticket-controlled overwrite semantics.
  const handoffSource = params.handoffSource ?? "cli"
  const receiptPayload = bytesToHex(
    sha256(JSON.stringify({ messages, meta, title: params.title, historicalState }))
  )
  const normalized = await Promise.all(uiMessages.map(normalizeMessageMedia))
  const resolvedProjectId = await resolveScopeProjectId(params.projectId)
  return db.transaction("rw", db.sessions, db.messages, db.messageMediaRefs, async () => {
    const priorReceipt =
      handoffSource === "cli"
        ? await db.sessions
            .filter(
              (s) =>
                s.cliHandoffReceipt?.sourceSessionId === params.sessionId &&
                s.cliHandoffReceipt.payloadDigest === receiptPayload
            )
            .first()
        : undefined
    if (priorReceipt) return priorReceipt
    const existing = await db.sessions.get(params.sessionId)
    const isPriorHandoff = existing?.handoffSource === handoffSource
    const collidesWithNative =
      existing != null &&
      (!isPriorHandoff || (handoffSource === "cli" && !!existing.cliHandoffReceipt))
    if (params.handoffLock && collidesWithNative)
      throw new Error("thread_handoff_target_session_collision")
    const sessionId =
      collidesWithNative || (handoffSource === "cli" && isPriorHandoff && !existing?.handoffLock)
        ? newSessionId()
        : params.sessionId
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
    const projectId = (isPriorHandoff ? existing?.projectId : undefined) ?? resolvedProjectId

    const session: ChatSession = {
      id: sessionId,
      projectId,
      title: params.title?.trim() || "Handoff from CLI",
      titleAuto: false,
      kind: "direct",
      // Lineage marker: distinguishes a re-handoff from a native-session collision
      // (see the collision guard above) and lets the UI show where it came from.
      handoffSource,
      ...(handoffSource === "cli"
        ? {
            cliHandoffReceipt: { sourceSessionId: params.sessionId, payloadDigest: receiptPayload },
          }
        : {}),
      model: meta?.model,
      providerOverride: meta?.provider,
      workingDir: meta?.cwd,
      ...(historicalState ? { importCanonicalState: historicalState } : {}),
      ...(context.losses.length
        ? {
            importLossReport: {
              fidelity: "contextual" as const,
              losses: context.losses.map((loss) => ({
                path: loss.messageId,
                kind: "dropped" as const,
                detail: loss.detail,
              })),
            },
          }
        : {}),
      // Preserve the original creation time on an idempotent re-handoff.
      createdAt: sessionId === existing?.id ? existing.createdAt : now,
      updatedAt: now,
      // Seed the truncated context for the first in-app send (no sdkSessionId to fork).
      branchKind: "direct",
      ...(transcript ? { branchSeed: { kind: "transcript" as const, content: transcript } } : {}),
    }

    {
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
      if (params.handoffLock) session.handoffLock = params.handoffLock
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
    }

    return session
  })
}
