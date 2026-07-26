const STORAGE_KEY = "cognia:pending-chat-prompt"
const DEFAULT_TTL_MS = 5 * 60 * 1000

interface PendingChatPrompt {
  sessionId: string
  prompt: string
  expiresAt: number
}

interface QueueOptions {
  now?: number
  ttlMs?: number
}

interface ConsumeOptions {
  now?: number
}

/**
 * Hand a controlled prompt from a settings surface to the normal chat sender.
 * Session storage keeps credentials and stale automation out of persisted app
 * state; the target pane consumes and deletes the value before sending.
 */
export function queuePendingChatPrompt(
  sessionId: string,
  prompt: string,
  options: QueueOptions = {}
): void {
  const trimmed = prompt.trim()
  if (!trimmed) throw new Error("Pending chat prompt cannot be empty")
  const now = options.now ?? Date.now()
  const record: PendingChatPrompt = {
    sessionId,
    prompt: trimmed,
    expiresAt: now + (options.ttlMs ?? DEFAULT_TTL_MS),
  }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record))
}

export function consumePendingChatPrompt(
  sessionId: string,
  options: ConsumeOptions = {}
): string | null {
  const raw = sessionStorage.getItem(STORAGE_KEY)
  if (!raw) return null

  let record: PendingChatPrompt
  try {
    record = JSON.parse(raw) as PendingChatPrompt
  } catch {
    sessionStorage.removeItem(STORAGE_KEY)
    return null
  }

  if (
    typeof record.sessionId !== "string" ||
    typeof record.prompt !== "string" ||
    typeof record.expiresAt !== "number"
  ) {
    sessionStorage.removeItem(STORAGE_KEY)
    return null
  }
  if (record.expiresAt < (options.now ?? Date.now())) {
    sessionStorage.removeItem(STORAGE_KEY)
    return null
  }
  if (record.sessionId !== sessionId) return null

  sessionStorage.removeItem(STORAGE_KEY)
  return record.prompt
}
