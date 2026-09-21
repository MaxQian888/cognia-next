import { getDb } from "./schema"
import { enqueueHostStateIntentIfAvailable } from "./mobile-outbound-queue"
import type { ChatTemplateBinding } from "@/lib/chat/template/binding"
import type { ContextRef } from "@/lib/chat/mentions/types"
import type { ContextSelectionRef } from "@/types/artifact/artifact"
import type { VideoPreprocessSettings } from "@/lib/chat/attachments/video/settings"
import type { AttachmentExtractedContent } from "@cognia/agent-config-types/attachment"

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
  extractedContent?: AttachmentExtractedContent
  ocrText?: string
  includeOcr?: boolean
  tokens?: number
  /**
   * How a staged video or animated GIF was set to be sampled. Its frames are
   * not stored — they are cheap to re-derive from `bytes` and large to keep —
   * so a restored draft re-runs the pipeline with these. Parsed with
   * `isVideoPreprocessSettings` on the way back in: the row may predate or
   * postdate this build.
   */
  videoSettings?: VideoPreprocessSettings
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
  /**
   * What this attachment cites: a remote document picked with `@lark:` /
   * `@google:` names the document it was fetched from. Restored with the file
   * so switching conversations and back does not silently uncite a document
   * that is still staged. See `lib/chat/mentions/attachment-citations.ts`.
   *
   * Local only, like `bytes`: the Host projection carries names and sizes.
   */
  citation?: ContextRef
}

/**
 * Ceiling for persisted draft attachment binaries and extracted caches combined.
 *
 * Six attachments × 10 MB × N sessions is unbounded, and blowing the IndexedDB
 * quota on iOS gets the WHOLE database evicted by the system — conversation
 * history included. A global cap with LRU eviction keeps the failure mode
 * proportionate: the oldest session loses its binaries (and falls back to the
 * reminder chips), prioritizing the newest, and never the message log.
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
  /**
   * Short label → the full URL it stands in for, for links this draft folded
   * (`lib/chat/link-fold.ts`).
   *
   * Same reason as `templateBinding` above: the composer's text holds the SHORT
   * form, so the URL has nowhere to live inside `text`. Losing this map would
   * not lose the draft — it would send `svenstaro/genact` as literal prose
   * where the user wrote a link, which is the one outcome worth a column.
   *
   * DEVICE-LOCAL, like `templateBinding`: `draft.replace` carries text and
   * attachments only. A draft that reaches another device arrives with its
   * labels unfolded into plain words, which reads oddly but never lies about
   * where a link pointed.
   */
  foldedLinks?: Record<string, string>
  /**
   * The context chips staged beside the text — `@memory:`/`@chat:`/`@msg:`
   * picks, file excerpts, artifact ranges.
   *
   * Each ref carries its own snapshot, fingerprint and `stale` marker, so a
   * restored draft re-stages the chip exactly as it was captured; staleness is
   * re-checked on hydrate and on send, never re-frozen silently.
   *
   * DEVICE-LOCAL, like `templateBinding` and `foldedLinks`: `draft.replace`
   * carries text and attachments only, so a draft projected to another device
   * arrives without its chips rather than with chips whose snapshots never
   * crossed the wire.
   */
  contextSelections?: ContextSelectionRef[]
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
  /**
   * Folded-link map to store. Three-way like `templateBinding`: omit to
   * PRESERVE, pass a map to replace, pass `null` to clear.
   */
  foldedLinks?: Record<string, string> | null
  /**
   * Context selections to store. Three-way like `templateBinding`: omit to
   * PRESERVE, pass a list to replace, pass `null` to clear.
   */
  contextSelections?: ContextSelectionRef[] | null
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
  const db = getDb()
  // Cancelling a pending debounced save used to ride the early `clearDraftLocal`
  // call on the empty path. The row delete itself now happens inside the
  // transaction below (where the preserved-selections read lives), but the
  // timer is a module map — safe to cancel here, before any async work.
  if (text.length === 0 && attachments.length === 0) {
    const pending = debounceTimers.get(sessionId)
    if (pending) {
      clearTimeout(pending)
      debounceTimers.delete(sessionId)
    }
  }
  // Local and authority writes share one `revision` field, so a local write has
  // to continue the row's own sequence — deriving it from a wall clock (or from
  // a module-global that never observes the authority's writes) lets a local
  // edit land *below* what the Host already published, which regresses the
  // channel and makes the next broadcast reuse a revision. The transaction
  // serializes revision allocation across tabs and orders saves with deletes.
  await db.transaction("rw", db.sessions, db.syncTombstones, db.chatDrafts, async () => {
    // Some callers seed a draft before their optimistic session is persisted.
    // Reject only a known deletion, while allowing an explicitly recreated row.
    if (
      (await db.sessions.where("id").equals(sessionId).count()) === 0 &&
      (await db.syncTombstones.get(["sessions", sessionId]))
    ) {
      return false
    }
    const previous = await db.chatDrafts.get(sessionId)
    // Omitted means keep; `null` means clear. See `SetDraftOptions`.
    const templateBinding =
      options.templateBinding === undefined ? previous?.templateBinding : options.templateBinding
    const foldedLinks =
      options.foldedLinks === undefined ? previous?.foldedLinks : options.foldedLinks
    const contextSelections =
      options.contextSelections === undefined
        ? previous?.contextSelections
        : (options.contextSelections ?? undefined)
    // A draft is empty only when the text, the attachment list AND the staged
    // context chips are all empty — a staged image or a `@chat:` pick with
    // no typed words is still worth restoring. Resolved inside the
    // transaction so the "preserve" read of `previous` cannot race a
    // concurrent save.
    if (text.length === 0 && attachments.length === 0 && !contextSelections?.length) {
      await db.chatDrafts.delete(sessionId)
      return false
    }
    const revision = options.revision ?? (previous?.revision ?? 0) + 1
    await db.chatDrafts.put({
      sessionId,
      text,
      updatedAt: Date.now(),
      revision,
      ...(templateBinding ? { templateBinding } : {}),
      ...(foldedLinks && Object.keys(foldedLinks).length > 0 ? { foldedLinks } : {}),
      ...(contextSelections && contextSelections.length > 0 ? { contextSelections } : {}),
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
    // Enforce in this transaction: a single oversized draft cannot be
    // committed above the budget, even if a later sweep is interrupted.
    if (attachments.some((a) => attachmentCacheBytes(a) > 0)) {
      await enforceDraftAttachmentQuota(sessionId)
    }
    return true
  })
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
 * Conservative UTF-16 storage accounting without making a second serialized
 * copy of potentially large extracted text. Extraction metadata is JSON data.
 */
function extractedValueBytes(value: unknown): number {
  if (typeof value === "string") return value.length * 2
  if (typeof value === "number") return 8
  if (typeof value === "boolean") return 4
  if (!value || typeof value !== "object") return 0
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + extractedValueBytes(item), 0)
  return Object.entries(value).reduce(
    (sum, [key, item]) => sum + key.length * 2 + extractedValueBytes(item),
    0
  )
}

function attachmentCacheBytes(attachment: DraftAttachmentMeta): number {
  // The declared source size remains a conservative fallback for old snapshot
  // readers, but an understated size cannot hide the actual typed-array bytes.
  const binaryBytes = attachment.bytes
    ? Math.max(
        attachment.bytes.byteLength || 0,
        Number.isFinite(attachment.size) ? attachment.size : 0
      )
    : 0
  return (
    binaryBytes +
    extractedValueBytes(attachment.extractedText) +
    extractedValueBytes(attachment.ocrText) +
    extractedValueBytes(attachment.extractedContent)
  )
}

function rowBytes(row: ChatDraftRow): number {
  return (row.attachments ?? []).reduce((sum, a) => sum + attachmentCacheBytes(a), 0)
}

/**
 * Drop attachment binaries and derived caches, oldest session first, until the total is back under
 * {@link DRAFT_ATTACHMENT_QUOTA_BYTES}.
 *
 * Reminder metadata stays. The just-written session is considered last; if
 * that session alone exceeds the quota, its earliest attachments are evicted
 * first so recent additions survive whenever they fit by themselves.
 */
export async function enforceDraftAttachmentQuota(keepSessionId?: string): Promise<void> {
  const db = getDb()
  // A quota sweep rewrites existing rows. Keep its read and write together so
  // it cannot restore a deleted draft from an older snapshot.
  await db.transaction("rw", db.chatDrafts, async () => {
    // `updatedAt` is indexed, so this walks oldest-first without a full sort.
    const rows = await db.chatDrafts.orderBy("updatedAt").toArray()
    let total = rows.reduce((sum, row) => sum + rowBytes(row), 0)
    if (total <= DRAFT_ATTACHMENT_QUOTA_BYTES) return

    const stripped: ChatDraftRow[] = []
    const evictionOrder = [
      ...rows.filter((row) => row.sessionId !== keepSessionId),
      ...rows.filter((row) => row.sessionId === keepSessionId),
    ]
    for (const row of evictionOrder) {
      if (total <= DRAFT_ATTACHMENT_QUOTA_BYTES) break
      let changed = false
      const attachments = (row.attachments ?? []).map((attachment) => {
        const freed = attachmentCacheBytes(attachment)
        if (total <= DRAFT_ATTACHMENT_QUOTA_BYTES || freed === 0) return attachment
        const {
          bytes: _bytes,
          extractedText: _text,
          extractedContent: _content,
          ocrText: _ocr,
          includeOcr: _includeOcr,
          tokens: _tokens,
          ...reminder
        } = attachment
        total -= freed
        changed = true
        return reminder
      })
      if (changed) stripped.push({ ...row, attachments })
    }
    if (stripped.length > 0) await db.chatDrafts.bulkPut(stripped)
  })
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
