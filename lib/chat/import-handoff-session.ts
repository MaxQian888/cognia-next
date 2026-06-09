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

import type { ChatSession } from "@/lib/claude/types"
import { getDb } from "@/lib/db/schema"
import { persistMessages, invalidatePersistSnapshot } from "@/lib/db/messages"
import { renderTranscript } from "@/lib/chat/branch-session"

export interface HandoffMessage {
  role: "user" | "assistant" | "system"
  content: string
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
  /** Injected clock for deterministic tests. */
  now?: number
}

function newMessageId(seed: string): string {
  return `m_${seed}_${Math.random().toString(36).slice(2, 8)}`
}

function toUiMessages(messages: HandoffMessage[]): UIMessage[] {
  return messages.map(
    (m, i) =>
      ({
        id: newMessageId(`${i}`),
        role: m.role,
        parts: [{ type: "text", text: m.content }],
      }) as UIMessage
  )
}

/**
 * Materialise a handed-off transcript as a continuable desktop session.
 * Idempotent on `sessionId` (a repeat handoff overwrites the row + messages).
 * Returns the created {@link ChatSession}.
 */
export async function importHandoffSession(params: ImportHandoffParams): Promise<ChatSession> {
  const { sessionId, messages, meta } = params
  if (!sessionId) throw new Error("importHandoffSession: sessionId is required")

  const now = params.now ?? Date.now()
  const uiMessages = toUiMessages(messages)
  const transcript = renderTranscript(uiMessages)

  const session: ChatSession = {
    id: sessionId,
    title: params.title?.trim() || "Handoff from CLI",
    titleAuto: false,
    kind: "direct",
    model: meta?.model,
    providerOverride: meta?.provider,
    workingDir: meta?.cwd,
    createdAt: now,
    updatedAt: now,
    // Tag the lineage so the UI can show "handed off from the CLI", and seed
    // the truncated context for the first in-app send (no sdkSessionId to fork).
    branchKind: "direct",
    ...(transcript ? { branchSeed: { kind: "transcript" as const, content: transcript } } : {}),
  }

  await getDb().sessions.put(session)
  invalidatePersistSnapshot(sessionId)
  await persistMessages(sessionId, uiMessages)

  return session
}
