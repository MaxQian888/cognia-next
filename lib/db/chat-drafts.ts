import { getDb } from "./schema"

/**
 * An attachment that was staged in the composer when a draft was saved.
 *
 * The binary IS persisted now: switching sessions used to destroy staged
 * attachments outright, leaving only a "you had these files" reminder and
 * forcing the user to re-attach them. `bytes` is the escape from that, and
 * `extractedText` rides along so a restored document does not have to be
 * re-parsed.
 *
 * Stored as a `Uint8Array` rather than a `Blob` deliberately: Blob-in-IndexedDB
 * has a history of lifetime quirks on WebKit (which is what the Tauri and
 * Capacitor shells run), and a typed array is the more portable payload.
 *
 * Both are optional. Rows written before this change — and rows whose binary
 * was evicted by {@link enforceDraftAttachmentQuota} — carry metadata only and
 * degrade to exactly the old reminder-chip behaviour.
 */
export interface DraftAttachmentMeta {
  name: string
  mediaType: string
  /** Real byte size. Previously derived from the URL and therefore always 0. */
  size: number
  /** The staged bytes. Absent once evicted, or for pre-existing rows. */
  bytes?: Uint8Array
  /** Cached extraction, so a restored document is not parsed a second time. */
  extractedText?: string
  tokens?: number
}

/**
 * Ceiling for all persisted draft attachment binaries combined.
 *
 * Six attachments × 10 MB × N sessions is unbounded, and blowing the IndexedDB
 * quota on iOS gets the WHOLE database evicted by the system — conversation
 * history included. A global cap with LRU eviction keeps the failure mode
 * proportionate: the oldest session loses its binaries (and falls back to the
 * reminder chips), never the newest, and never the message log.
 */
export const DRAFT_ATTACHMENT_QUOTA_BYTES = 150 * 1024 * 1024

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
  // Enforce AFTER the write so the row just saved counts toward the total and
  // is the one protected from eviction.
  if (attachments.some((a) => a.bytes)) await enforceDraftAttachmentQuota(sessionId)
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

/**
 * Bytes of persisted binary carried by one draft row.
 *
 * Reads the explicit `size` field rather than measuring the payload: `size` is
 * recorded at staging time from the real `File.size`, so the accounting stays
 * correct regardless of how the storage layer rehydrates the typed array.
 */
function rowBytes(row: ChatDraftRow): number {
  return (row.attachments ?? []).reduce((sum, a) => sum + (a.bytes ? a.size : 0), 0)
}

/**
 * Drop attachment binaries, oldest session first, until the total is back under
 * {@link DRAFT_ATTACHMENT_QUOTA_BYTES}.
 *
 * Only `bytes` is stripped — name / size / extracted text stay, so an evicted
 * draft still shows its reminder chips. The row for `keepSessionId` (the one
 * just written) is never evicted, so the attachment a user just staged is
 * always the one that survives.
 */
export async function enforceDraftAttachmentQuota(keepSessionId?: string): Promise<void> {
  const db = getDb()
  // `updatedAt` is indexed, so this walks oldest-first without a full sort.
  const rows = await db.chatDrafts.orderBy("updatedAt").toArray()
  let total = rows.reduce((sum, row) => sum + rowBytes(row), 0)
  if (total <= DRAFT_ATTACHMENT_QUOTA_BYTES) return

  const stripped: ChatDraftRow[] = []
  for (const row of rows) {
    if (total <= DRAFT_ATTACHMENT_QUOTA_BYTES) break
    if (row.sessionId === keepSessionId) continue
    const freed = rowBytes(row)
    if (freed === 0) continue
    stripped.push({
      ...row,
      attachments: (row.attachments ?? []).map(({ bytes: _bytes, ...rest }) => rest),
    })
    total -= freed
  }
  if (stripped.length > 0) await db.chatDrafts.bulkPut(stripped)
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
