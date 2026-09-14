/**
 * The citations a turn makes through the attachments it sends.
 *
 * A remote document picked with `@lark:` / `@google:` (ADR-0134) is fetched and
 * staged as an ordinary attachment, so no `@…` token survives in the text and
 * its citation has to come from somewhere else. It used to be appended to the
 * composer's `citedRefs` as a side effect of the pick, which let the two drift
 * apart: a fetch that failed was still cited, and so was a document whose chip
 * was removed before sending. `metadata.mentions` then claimed a document the
 * model never saw. This is the attachment counterpart of
 * `selection-citations.ts`: a citation belongs to one staged attachment, and a
 * turn cites exactly the attachments it submits.
 *
 * The attachment id is the hard part. The vendored `PromptInputProvider` mints
 * ids inside `add()` and returns nothing, so the id a file will get cannot be
 * known when it is handed over. The binding therefore works the way
 * `StagedAttachmentsValue.seedIncoming` does: the file is announced (`expect`)
 * immediately before `add()`, and the first newly observed attachment with the
 * same name and media type takes the citation (`observe`). From then on the
 * citation is keyed by the real id, so removing that chip removes the citation
 * from every later send, however many same-named files sit beside it.
 */

import type { RemoteDocRef } from "@/lib/docs-providers"
import type { ContextRef } from "./types"
import { mergeContextRefs } from "./merge-refs"

/** The fields of a staged attachment the binding reads. */
export interface ObservedAttachment {
  id: string
  filename?: string
  mediaType?: string
}

/** A submitted file, plus (optionally) its staging-time extraction. */
export interface SubmittedAttachment {
  id?: string
}

/** Only `block` is read: `null` means the extraction rejected the file. */
export interface StagedExtraction {
  block: unknown
}

export interface AttachmentCitations {
  /**
   * Announce that `file` is about to be staged and cites `citation`.
   *
   * Must be called synchronously right before the provider's `add()`, so the
   * observation that first sees the new attachment always finds this entry.
   * An announcement for a file that is never added lingers only until the next
   * observation that sees a new attachment: see {@link observe}.
   */
  expect(file: { name: string; type: string }, citation: ContextRef): void
  /**
   * Reconcile with the provider's current attachment list. Call it every time
   * the list changes.
   *
   * Each newly observed attachment takes the first announced citation whose
   * name and media type match. An announcement that no new attachment matched
   * in an observation that DID see new attachments is dropped: its `add()` has
   * been processed, so the file was not staged after all. Dropping it errs
   * toward citing too little. Keeping it could hand the citation to an
   * unrelated file of the same name staged later.
   */
  observe(files: readonly ObservedAttachment[]): void
  /** The citation bound to a staged attachment, if any. */
  citationOf(id: string): ContextRef | undefined
  /**
   * The citations of the files a turn submits, in submission order, each
   * document once.
   *
   * A file whose staging-time extraction was rejected contributes no content,
   * so it cites nothing either. A binding outlives its chip on purpose, up to
   * {@link DETACHED_BINDING_LIMIT} of them: the send reads the file list it
   * snapshotted, which still holds a chip removed while the send was waiting
   * (on the over-length confirmation, say), and that file IS sent.
   */
  citationsFor(
    files: readonly SubmittedAttachment[],
    precomputed?: ReadonlyMap<string, StagedExtraction>
  ): ContextRef[]
}

/**
 * How many bindings of removed attachments are kept before the oldest go.
 * Ids are never reused, so a stale binding can only ever answer for its own
 * file. The limit only stops a composer that stays mounted for days from
 * accumulating one entry per document ever picked.
 */
export const DETACHED_BINDING_LIMIT = 64

interface Announcement {
  name: string
  type: string
  citation: ContextRef
}

export function createAttachmentCitations(): AttachmentCitations {
  /** Attachment id → citation. Insertion order is binding order. */
  const bound = new Map<string, ContextRef>()
  /** The ids the last observation saw. */
  let live = new Set<string>()
  let announced: Announcement[] = []

  function evictDetached(): void {
    let detached = 0
    for (const id of bound.keys()) if (!live.has(id)) detached++
    if (detached <= DETACHED_BINDING_LIMIT) return
    for (const id of bound.keys()) {
      if (detached <= DETACHED_BINDING_LIMIT) break
      if (live.has(id)) continue
      bound.delete(id)
      detached--
    }
  }

  return {
    expect(file, citation) {
      announced.push({ name: file.name, type: file.type, citation })
    },

    observe(files) {
      const fresh = files.filter((file) => !live.has(file.id))
      live = new Set(files.map((file) => file.id))
      if (fresh.length === 0) return
      for (const file of fresh) {
        const at = announced.findIndex(
          (entry) => entry.name === (file.filename ?? "") && entry.type === (file.mediaType ?? "")
        )
        if (at < 0) continue
        bound.set(file.id, announced[at]!.citation)
        announced.splice(at, 1)
      }
      announced = []
      evictDetached()
    },

    citationOf(id) {
      return bound.get(id)
    },

    citationsFor(files, precomputed) {
      const refs = files.flatMap((file): ContextRef[] => {
        if (!file.id) return []
        const citation = bound.get(file.id)
        if (!citation) return []
        if (precomputed?.get(file.id)?.block === null) return []
        return [citation]
      })
      // The same document picked twice is two attachments and one citation.
      return mergeContextRefs(refs, [])
    },
  }
}

/**
 * `<providerId>:<documentId>`, the id shape `types.ts` documents for `doc`.
 *
 * Built only from a fetch that succeeded, so it needs no guard of its own: a
 * pick whose body never arrived stages no file and so is never cited.
 */
export function remoteDocCitation(
  item: { providerId: string; doc: RemoteDocRef },
  resolvedTitle: string
): ContextRef {
  return {
    kind: "doc",
    id: `${item.providerId}:${item.doc.id}`,
    label: resolvedTitle || item.doc.title,
    raw: item.doc.url ?? `@${item.providerId}:${item.doc.id}`,
  }
}
