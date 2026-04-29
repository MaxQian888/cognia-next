import type { ChatSession } from "@/lib/claude/types"
import { getDb } from "./schema"

function newId() {
  return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export async function listSessions(): Promise<ChatSession[]> {
  return getDb().sessions.orderBy("updatedAt").reverse().toArray()
}

export async function getSession(id: string): Promise<ChatSession | undefined> {
  return getDb().sessions.get(id)
}

export async function createSession(
  partial?: Partial<Omit<ChatSession, "id" | "createdAt" | "updatedAt">>
): Promise<ChatSession> {
  const now = Date.now()
  const session: ChatSession = {
    id: newId(),
    title: partial?.title ?? "New chat",
    kind: partial?.kind ?? "direct",
    characterId: partial?.characterId,
    teamId: partial?.teamId,
    disabledSkillIds: partial?.disabledSkillIds,
    pinned: partial?.pinned,
    model: partial?.model,
    systemPrompt: partial?.systemPrompt,
    workingDir: partial?.workingDir,
    permissionMode: partial?.permissionMode,
    scratchpad: partial?.scratchpad,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().sessions.put(session)
  return session
}

export async function updateSession(
  id: string,
  patch: Partial<Omit<ChatSession, "id" | "createdAt">>
): Promise<void> {
  await getDb().sessions.update(id, { ...patch, updatedAt: Date.now() })
}

export async function deleteSession(id: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.sessions, db.messages, async () => {
    await db.messages.where("sessionId").equals(id).delete()
    await db.sessions.delete(id)
  })
}

export async function touchSession(id: string): Promise<void> {
  await getDb().sessions.update(id, { updatedAt: Date.now() })
}

/**
 * Persist the SDK-issued session id (so we can resume after a sidecar restart).
 * No-op when the row is missing or already carries the same id; we don't bump
 * `updatedAt` because this isn't user-visible state.
 */
export async function setSdkSessionId(id: string, sdkSessionId: string): Promise<void> {
  const row = await getDb().sessions.get(id)
  if (!row || row.sdkSessionId === sdkSessionId) return
  await getDb().sessions.update(id, { sdkSessionId })
}
