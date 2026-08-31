const LEGACY_STORAGE_KEY = "cognia:pending-chat-prompt"
const STORAGE_KEY = "cognia:pending-chat-prompt:v2"
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export interface PendingChatPrompt {
  id: string
  sessionId: string
  prompt: string
  skillIds: string[]
  requestId?: string
  createdAt: number
  expiresAt: number
}

interface QueueOptions {
  now?: number
  ttlMs?: number
  skillIds?: readonly string[]
  requestId?: string
}

interface ReadOptions {
  now?: number
}

function storageAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined"
}

function sessionStorageAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined"
}

function makeDispatchId(sessionId: string, now: number): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return `pending:${sessionId}:${now}:${suffix}`
}

function validRecord(value: unknown): value is PendingChatPrompt {
  if (!value || typeof value !== "object") return false
  const row = value as Partial<PendingChatPrompt>
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    typeof row.sessionId === "string" &&
    typeof row.prompt === "string" &&
    row.prompt.trim().length > 0 &&
    Array.isArray(row.skillIds) &&
    row.skillIds.every((id) => typeof id === "string" && id.length > 0) &&
    (row.requestId === undefined || typeof row.requestId === "string") &&
    typeof row.createdAt === "number" &&
    Number.isFinite(row.createdAt) &&
    typeof row.expiresAt === "number" &&
    Number.isFinite(row.expiresAt)
  )
}

function parseRecord(raw: string | null): PendingChatPrompt | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return validRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function migrateLegacy(now: number): PendingChatPrompt | null {
  if (!sessionStorageAvailable()) return null
  const raw = window.sessionStorage.getItem(LEGACY_STORAGE_KEY)
  if (!raw) return null
  window.sessionStorage.removeItem(LEGACY_STORAGE_KEY)

  try {
    const value = JSON.parse(raw) as {
      sessionId?: unknown
      prompt?: unknown
      expiresAt?: unknown
    }
    if (
      typeof value.sessionId !== "string" ||
      typeof value.prompt !== "string" ||
      !value.prompt.trim() ||
      typeof value.expiresAt !== "number" ||
      value.expiresAt < now
    ) {
      return null
    }
    const record: PendingChatPrompt = {
      id: makeDispatchId(value.sessionId, now),
      sessionId: value.sessionId,
      prompt: value.prompt.trim(),
      skillIds: [],
      createdAt: now,
      expiresAt: value.expiresAt,
    }
    if (storageAvailable()) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
    return record
  } catch {
    return null
  }
}

/**
 * Persist a prompt handoff until the chat transcript proves that dispatch was
 * accepted. The record is device-local and deliberately contains only the
 * controlled prompt plus skill ids — never credentials or arbitrary context.
 */
export function queuePendingChatPrompt(
  sessionId: string,
  prompt: string,
  options: QueueOptions = {}
): PendingChatPrompt {
  const trimmed = prompt.trim()
  if (!trimmed) throw new Error("Pending chat prompt cannot be empty")
  const now = options.now ?? Date.now()
  const skillIds = Array.from(new Set(options.skillIds ?? [])).filter(Boolean)
  const record: PendingChatPrompt = {
    id: makeDispatchId(sessionId, now),
    sessionId,
    prompt: trimmed,
    skillIds,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    createdAt: now,
    expiresAt: now + (options.ttlMs ?? DEFAULT_TTL_MS),
  }
  if (storageAvailable()) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
  return record
}

/** Read without deleting. Deletion requires an exact dispatch acknowledgement. */
export function peekPendingChatPrompt(
  sessionId: string,
  options: ReadOptions = {}
): PendingChatPrompt | null {
  const now = options.now ?? Date.now()
  if (!storageAvailable()) return migrateLegacy(now)
  const raw = window.localStorage.getItem(STORAGE_KEY)
  let record = parseRecord(raw)
  if (raw && !record) {
    window.localStorage.removeItem(STORAGE_KEY)
    return null
  }
  record ??= migrateLegacy(now)
  if (!record) return null
  if (record.expiresAt < now) {
    window.localStorage.removeItem(STORAGE_KEY)
    return null
  }
  return record.sessionId === sessionId ? record : null
}

/** Remove only the record that the caller observed and successfully dispatched. */
export function acknowledgePendingChatPrompt(sessionId: string, id: string): boolean {
  if (!storageAvailable()) return false
  const record = parseRecord(window.localStorage.getItem(STORAGE_KEY))
  if (!record || record.sessionId !== sessionId || record.id !== id) return false
  window.localStorage.removeItem(STORAGE_KEY)
  return true
}

/**
 * Compatibility API for non-onboarding callers. New request-scoped handoffs
 * use `peekPendingChatPrompt` + `acknowledgePendingChatPrompt` instead.
 */
export function consumePendingChatPrompt(
  sessionId: string,
  options: ReadOptions = {}
): string | null {
  const record = peekPendingChatPrompt(sessionId, options)
  if (!record) return null
  acknowledgePendingChatPrompt(sessionId, record.id)
  return record.prompt
}
