/**
 * Committing an edit to the transcript.
 *
 * Two steps that must not drift apart: the bytes enter the content-addressed
 * media store, and the message gains a part that references them. Both are
 * wrapped here so no caller can do one without the other.
 *
 * Ingestion runs BEFORE the append transaction, deliberately. Hashing and
 * re-encoding a 1568px frame is slow, and Dexie transactions do not survive an
 * await on unrelated async work: doing it inside would either block the
 * database for the duration or drop the transaction entirely.
 *
 * The reverse ordering is what makes the reclaim in `appendImageEditVersion`
 * necessary, and it is the right trade. A rejected append leaves an
 * unreferenced blob that is then collected, whereas the other order would leave
 * a message part pointing at bytes that were never stored.
 */

import { ingestImage } from "@/lib/chat/media/ingest-media"
import { appendImageEditVersion } from "@/lib/db/messages"

import {
  newImageEditVersionId,
  IMAGE_EDIT_SCHEMA_VERSION,
  type ImageEditOperation,
  type ImageEditVersionV1,
} from "./version"

export interface SaveImageEditInput {
  sessionId: string
  messageId: string
  /** The originating image's url. See `version.ts` for why this is the key. */
  lineageId: string
  /** `null` when the edit was made directly on the original. */
  parentVersionId: string | null
  bytes: Uint8Array
  mediaType: string
  operations: ImageEditOperation[]
  /** Set only when a model produced the pixels. */
  attribution?: { providerId?: string; modelId?: string } | null
  /**
   * Minted by the caller, once per save attempt.
   *
   * The caller owns it so a retry after a network or transaction failure can
   * present the SAME id and be recognised as a replay. Minting it here would
   * make every retry a new version.
   */
  versionId?: string
  filename?: string
  now?: () => number
}

export interface SaveImageEditResult {
  /** False when this version was already on the message. */
  appended: boolean
  /** `cognia-media:<hash>` of the stored result. */
  ref: string
  version: ImageEditVersionV1
}

export interface SaveImageEditDeps {
  ingest?: typeof ingestImage
  append?: typeof appendImageEditVersion
}

/**
 * Store the edited bytes and append them to the message as a new version.
 *
 * Returns the version record so the caller can select the new entry in the
 * rail without re-reading the transcript.
 */
export async function saveImageEditVersion(
  input: SaveImageEditInput,
  deps: SaveImageEditDeps = {}
): Promise<SaveImageEditResult> {
  const ingest = deps.ingest ?? ingestImage
  const append = deps.append ?? appendImageEditVersion
  const now = input.now ?? Date.now

  const version: ImageEditVersionV1 = {
    schemaVersion: IMAGE_EDIT_SCHEMA_VERSION,
    lineageId: input.lineageId,
    versionId: input.versionId ?? newImageEditVersionId(),
    parentVersionId: input.parentVersionId,
    operations: input.operations,
    editedAt: now(),
    ...(input.attribution?.providerId ? { providerId: input.attribution.providerId } : {}),
    ...(input.attribution?.modelId ? { modelId: input.attribution.modelId } : {}),
  }

  // `keepOriginal` is false: the untouched original is already a separate part
  // on the same message, so retaining a second copy of these derived bytes
  // would double the storage for nothing.
  const media = await ingest({
    bytes: input.bytes,
    mediaType: input.mediaType,
    keepOriginal: false,
  })

  const result = await append({
    sessionId: input.sessionId,
    messageId: input.messageId,
    media,
    version,
    ...(input.filename ? { filename: input.filename } : {}),
  })

  return { appended: result.appended, ref: media.ref, version }
}
