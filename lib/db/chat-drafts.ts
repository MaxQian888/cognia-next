import { getDb } from "./schema"
import { enqueueHostStateIntentIfAvailable } from "./mobile-outbound-queue"
import type { ChatTemplateBinding } from "@/lib/chat/template/binding"

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
  /**
   * SHA-256 of the staged bytes, lowercase hex.
   *
   * Computed once at staging time and carried so a resumed upload does not
   * re-hash a 10 MB file on a phone just to learn the key the Host already
   * knows it by.
   */
  hash?: string
  /**
   * The Host-side upload this file is (or was) being transferred through, and
   * how much of it landed.
   *
   * Kept on the draft rather than in an upload table of its own: the draft is
   * already the record of "what is staged in this composer", already survives
   * an app restart, and is already dropped when the target database goes. A
   * parallel table would be a second thing to keep in step with it, and the
   * two would disagree exactly when a restart interrupted a send.
   */
  uploadId?: string
  uploadedBytes?: number
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
  /** Shared-state revision. Absent on pre-v168 rows and interpreted as zero. */
  revision?: number
  /** Last attached client that authored the shared draft projection. */
  originClientId?: string
  /** Wire-safe metadata only; attachment bytes remain device-local. */
  attachmentRefs?: Array<{ name: string; mediaType: string; size: number; hash?: string }>
  /**
   * The template this draft was inserted from, and what its `{{parameters}}`
   * are set to.
   *
   * Values cannot live in `text` — the chip overlay is a character-for-character
   * mirror of the textarea, so a pill can only paint the token it covers. They
   * ride the draft row instead, which is what makes a reload restore a
   * half-filled template exactly.
   *
   * DEVICE-LOCAL for now: `draft.replace` carries `text` and `attachments`
   * only, so a draft that reaches another device arrives with its tokens but
   * without their values. That degrades safely rather than silently — the
   * receiving composer reads the tokens straight out of the text, finds nothing
   * bound, and refuses to send rather than shipping a literal `{{module}}` to
   * the model.
   */
  templateBinding?: ChatTemplateBinding
}

export interface SetDraftOptions {
  originClientId?: string
  /** Authority may provide an exact revision; local writes increment instead. */
  revision?: number
  /**
   * Template binding to store with the draft.
   *
   * Three-way on purpose: omit to PRESERVE whatever the row already holds,
   * pass a binding to replace it, pass `null` to clear it. Preserve has to be
   * the default because the composer's persist effect fires on every keystroke
   * with text and attachments only — anything else would erase the parameter
   * values the moment the user typed a character.
   */
  templateBinding?: ChatTemplateBinding | null
}

/**
 * Serializes the read-modify-write of a session's draft revision. A plain
 * promise chain rather than a Dexie transaction: draft saves are debounced and
 * uncontended in practice, and a transaction here would not settle under the
 * frozen timers the debounce tests run on.
 */
const draftRevisionLocks = new Map<string, Promise<void>>()

function withDraftRevisionLock(sessionId: string, run: () => Promise<void>): Promise<void> {
  const previous = draftRevisionLocks.get(sessionId) ?? Promise.resolve()
  const next = previous.then(run, run)
  // Keep the chain alive on failure so one rejected save cannot wedge the rest.
  draftRevisionLocks.set(
    sessionId,
    next.then(
      () => undefined,
      () => undefined
    )
  )
  return next
}

export async function getDraft(sessionId: string): Promise<ChatDraftRow | null> {
  const row = await getDb().chatDrafts.get(sessionId)
  return row ?? null
}

export async function setDraft(
  sessionId: string,
  text: string,
  attachments: DraftAttachmentMeta[] = [],
  options: SetDraftOptions = {}
): Promise<void> {
  let hostStateRow: Awaited<ReturnType<typeof enqueueHostStateIntentIfAvailable>> = null
  if (options.revision === undefined) {
    hostStateRow = await enqueueHostStateIntentIfAvailable({
      sessionId,
      action: {
        kind: "draft.replace",
        text,
        attachments: attachments.map(({ name, mediaType, size }) => ({ name, mediaType, size })),
      },
    })
  }
  // A draft is empty only when BOTH the text and the attachment list are empty —
  // a staged image with no caption is still worth restoring as a reminder.
  if (text.length === 0 && attachments.length === 0) {
    await clearDraftLocal(sessionId)
    return
  }
  const db = getDb()
  // Local and authority writes share one `revision` field, so a local write has
  // to continue the row's own sequence — deriving it from a wall clock (or from
  // a module-global that never observes the authority's writes) lets a local
  // edit land *below* what the Host already published, which regresses the
  // channel and makes the next broadcast reuse a revision. Serialized per
  // session so concurrent saves cannot read the same revision and both claim it.
  await withDraftRevisionLock(sessionId, async () => {
    const previous = await db.chatDrafts.get(sessionId)
    const revision = options.revision ?? (previous?.revision ?? 0) + 1
    // Omitted means keep; `null` means clear. See `SetDraftOptions`.
    const templateBinding =
      options.templateBinding === undefined ? previous?.templateBinding : options.templateBinding
    await db.chatDrafts.put({
      sessionId,
      text,
      updatedAt: Date.now(),
      revision,
      ...(templateBinding ? { templateBinding } : {}),
      ...(options.originClientId || hostStateRow?.clientId
        ? { originClientId: options.originClientId ?? hostStateRow?.clientId }
        : {}),
      // The content hash rides along so a draft restored after a restart can
      // rejoin its upload instead of re-hashing and re-sending the file.
      attachmentRefs: attachments.map(({ name, mediaType, size, hash }) => ({
        name,
        mediaType,
        size,
        ...(hash ? { hash } : {}),
      })),
      ...(attachments.length > 0 ? { attachments } : {}),
    })
  })
  // Enforce AFTER the write so the row just saved counts toward the total and
  // is the one protected from eviction.
  if (attachments.some((a) => a.bytes)) await enforceDraftAttachmentQuota(sessionId)
}

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

export async function clearDraft(
  sessionId: string,
  options: { hostAlreadyCleared?: boolean } = {}
): Promise<void> {
  if (!options.hostAlreadyCleared) {
    await enqueueHostStateIntentIfAvailable({
      sessionId,
      action: { kind: "draft.replace", text: "", attachments: [] },
    })
  }
  await clearDraftLocal(sessionId)
}

async function clearDraftLocal(sessionId: string): Promise<void> {
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

/**
 * Writes fired by {@link setDraftDebounced}, so callers (and tests) can await
 * the flush instead of guessing how many microtasks the write takes.
 */
const debouncedWrites = new Set<Promise<void>>()

export function setDraftDebounced(
  sessionId: string,
  text: string,
  attachments: DraftAttachmentMeta[] = [],
  delayMs = 500,
  options: SetDraftOptions = {}
): void {
  const existing = debounceTimers.get(sessionId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    debounceTimers.delete(sessionId)
    const write = setDraft(sessionId, text, attachments, options).catch(() => undefined)
    debouncedWrites.add(write)
    void write.finally(() => debouncedWrites.delete(write))
  }, delayMs)
  debounceTimers.set(sessionId, timer)
}

/** Resolves once every already-fired debounced write has hit Dexie. */
export async function flushDebouncedDraftWrites(): Promise<void> {
  while (debouncedWrites.size > 0) {
    await Promise.all([...debouncedWrites])
  }
}
