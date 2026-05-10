import { getDb } from "./schema"

export interface ChatDraftRow {
  sessionId: string
  text: string
  updatedAt: number
}

export async function getDraft(sessionId: string): Promise<ChatDraftRow | null> {
  const row = await getDb().chatDrafts.get(sessionId)
  return row ?? null
}

export async function setDraft(sessionId: string, text: string): Promise<void> {
  if (text.length === 0) {
    await clearDraft(sessionId)
    return
  }
  await getDb().chatDrafts.put({
    sessionId,
    text,
    updatedAt: Date.now(),
  })
}

export async function clearDraft(sessionId: string): Promise<void> {
  await getDb().chatDrafts.delete(sessionId)
}

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function setDraftDebounced(sessionId: string, text: string, delayMs = 500): void {
  const existing = debounceTimers.get(sessionId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    debounceTimers.delete(sessionId)
    void setDraft(sessionId, text)
  }, delayMs)
  debounceTimers.set(sessionId, timer)
}
