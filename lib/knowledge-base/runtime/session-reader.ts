/** Captured host execution authority; never reconstructed from model/plugin arguments. */
import {
  createKnowledgeReader,
  type KnowledgeReader,
  type KnowledgeReaderInput,
  type KnowledgeReadingAccess,
} from "./progressive-reading"

const readers = new Map<string, { reader: KnowledgeReader; expiresAt: number }>()
const authorities = new Map<
  string,
  {
    knowledgeBaseIds: readonly string[]
    knowledgeAccess: KnowledgeReadingAccess
    expiresAt: number
  }
>()
const MAX_IDLE_MS = 60 * 60 * 1_000

export function registerKnowledgeAccessForSession(
  sessionId: string,
  input: { knowledgeBaseIds: readonly string[]; knowledgeAccess?: KnowledgeReadingAccess }
): void {
  if (!sessionId.trim()) throw new Error("session_required")
  const now = Date.now()
  for (const [id, value] of authorities) if (value.expiresAt <= now) authorities.delete(id)
  authorities.set(sessionId, {
    knowledgeBaseIds: [...input.knowledgeBaseIds],
    knowledgeAccess: structuredClone(input.knowledgeAccess ?? {}),
    expiresAt: now + MAX_IDLE_MS,
  })
}
/** Defensive copies let nested dispatch narrow a ceiling without mutating its parent. */
export function getKnowledgeAccessForSession(
  sessionId: string
): { knowledgeBaseIds: readonly string[]; knowledgeAccess: KnowledgeReadingAccess } | undefined {
  const value = authorities.get(sessionId)
  if (!value) return undefined
  if (value.expiresAt <= Date.now()) {
    authorities.delete(sessionId)
    return undefined
  }
  value.expiresAt = Date.now() + MAX_IDLE_MS
  return {
    knowledgeBaseIds: [...value.knowledgeBaseIds],
    knowledgeAccess: structuredClone(value.knowledgeAccess),
  }
}

export function registerKnowledgeReaderForSession(
  sessionId: string,
  input: KnowledgeReaderInput
): void {
  if (!sessionId.trim()) throw new Error("session_required")
  const now = Date.now()
  registerKnowledgeAccessForSession(sessionId, {
    knowledgeBaseIds: input.knowledgeBaseIds,
    knowledgeAccess: {
      entrypoint: input.entrypoint,
      triggeredBy: input.triggeredBy,
      revisionBindings: input.revisionBindings,
      allowedKnowledgeBaseIds: input.allowedKnowledgeBaseIds,
    },
  })
  for (const [id, value] of readers) if (value.expiresAt <= now) readers.delete(id)
  readers.set(sessionId, { reader: createKnowledgeReader(input), expiresAt: now + MAX_IDLE_MS })
}
export function getKnowledgeReaderForSession(sessionId: string): KnowledgeReader | undefined {
  const value = readers.get(sessionId)
  if (!value) return undefined
  if (value.expiresAt <= Date.now()) {
    readers.delete(sessionId)
    return undefined
  }
  value.expiresAt = Date.now() + MAX_IDLE_MS
  return value.reader
}
export function clearKnowledgeReaderForSession(sessionId: string): void {
  readers.delete(sessionId)
  authorities.delete(sessionId)
}
