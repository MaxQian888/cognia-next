import { getDb } from "./schema"

/**
 * Lightweight descriptor of an attachment that was staged in the composer when a
 * draft was saved. We persist only metadata — NOT the binary — so switching
 * sessions or reloading restores the typed text and tells the user which files
 * they still need to re-attach, without bloating IndexedDB with image blobs.
 */
export interface DraftAttachmentMeta {
  name: string
  mediaType: string
  size: number
}

export interface ChatDraftRow {
  sessionId: string
  text: string
  updatedAt: number
  /** Metadata for attachments staged when the draft was saved. Optional so
   * pre-existing text-only rows keep working unchanged. */
  attachments?: DraftAttachmentMeta[]
}

export async function getDraft(sessionId: string): Promise<ChatDraftRow | null> {
  const row = await getDb().chatDrafts.get(sessionId)
  return row ?? null
}

export async function setDraft(
  sessionId: string,
  text: string,
  attachments: DraftAttachmentMeta[] = []
): Promise<void> {
  // A draft is empty only when BOTH the text and the attachment list are empty —
  // a staged image with no caption is still worth restoring as a reminder.
  if (text.length === 0 && attachments.length === 0) {
    await clearDraft(sessionId)
    return
  }
  await getDb().chatDrafts.put({
    sessionId,
    text,
    updatedAt: Date.now(),
    ...(attachments.length > 0 ? { attachments } : {}),
  })
}

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

export async function clearDraft(sessionId: string): Promise<void> {
  // Cancel any pending debounced save first, otherwise an in-flight write
  // re-creates the row right after we delete it (e.g. on optimistic
  // clear-after-send), leaving stale text that reappears next time the
  // session is opened.
  const pending = debounceTimers.get(sessionId)
  if (pending) {
    clearTimeout(pending)
    debounceTimers.delete(sessionId)
  }
  await getDb().chatDrafts.delete(sessionId)
}

export function setDraftDebounced(
  sessionId: string,
  text: string,
  attachments: DraftAttachmentMeta[] = [],
  delayMs = 500
): void {
  const existing = debounceTimers.get(sessionId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    debounceTimers.delete(sessionId)
    void setDraft(sessionId, text, attachments)
  }, delayMs)
  debounceTimers.set(sessionId, timer)
}
