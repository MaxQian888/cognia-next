import type { ChatSession } from "@/lib/claude/types"
import { getDb } from "./schema"
import { getDefaultPreset, recordPresetUsage } from "./prompt-presets"
import { buildAutoApplySessionPatch } from "@/lib/presets/apply-to-session"

function newId() {
  return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export async function listSessions(): Promise<ChatSession[]> {
  return getDb().sessions.orderBy("updatedAt").reverse().toArray()
}

export async function getSession(id: string): Promise<ChatSession | undefined> {
  return getDb().sessions.get(id)
}

/**
 * Create a fresh chat session row. When the caller provides no character or
 * team and no override fields, the user's default preset (if any) is auto-
 * applied — its `content` becomes the session's `systemPrompt`, and any of
 * `model` / `permissionMode` / `workingDir` the preset carries are copied
 * across. The preset's `usageCount` / `lastUsedAt` are updated as well.
 *
 * Auto-apply only touches fields that are still empty on `partial`; any
 * caller-provided value wins. Failures looking up the default preset are
 * swallowed — auto-apply is a convenience, not a load-bearing invariant.
 *
 * Auto-apply intentionally only fills the four ChatSession-row fields above.
 * Tool / MCP / skill / agent-mode preset overrides require explicit user
 * action via the chat-header config sheet; rolling them into session
 * creation would couple this helper to the agent-mode store and several
 * stores at once with no UI surface to undo it.
 */
export async function createSession(
  partial?: Partial<Omit<ChatSession, "id" | "createdAt" | "updatedAt">>
): Promise<ChatSession> {
  const now = Date.now()

  let autoApplied: {
    systemPrompt?: string
    model?: string
    permissionMode?: ChatSession["permissionMode"]
    workingDir?: string
  } = {}
  let autoAppliedPresetId: string | undefined

  const shouldAutoApply =
    !partial?.characterId &&
    !partial?.teamId &&
    !partial?.systemPrompt &&
    !partial?.model &&
    !partial?.permissionMode &&
    !partial?.workingDir

  if (shouldAutoApply) {
    try {
      const def = await getDefaultPreset()
      if (def) {
        autoApplied = buildAutoApplySessionPatch(def, partial ?? {})
        autoAppliedPresetId = def.id
      }
    } catch (err) {
      // Non-fatal — log via console.warn so test runs surface unexpected errors
      // but production flows continue without a default applied.
      console.warn("createSession: default preset auto-apply failed", err)
    }
  }

  const session: ChatSession = {
    id: newId(),
    title: partial?.title ?? "New chat",
    kind: partial?.kind ?? "direct",
    characterId: partial?.characterId,
    teamId: partial?.teamId,
    disabledSkillIds: partial?.disabledSkillIds,
    pinned: partial?.pinned,
    model: partial?.model ?? autoApplied.model,
    systemPrompt: partial?.systemPrompt ?? autoApplied.systemPrompt,
    workingDir: partial?.workingDir ?? autoApplied.workingDir,
    permissionMode: partial?.permissionMode ?? autoApplied.permissionMode,
    scratchpad: partial?.scratchpad,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().sessions.put(session)
  if (autoAppliedPresetId) {
    // Wait for the usage bump so the "Recent" filter in the section reflects
    // this session immediately. The cost is one extra Dexie update per
    // creation; it's bounded and not on the chat hot path.
    await recordPresetUsage(autoAppliedPresetId).catch(() => undefined)
  }
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
