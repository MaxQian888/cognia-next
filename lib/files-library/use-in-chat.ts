/**
 * "Use in chat" from the Files page (ADR-0200).
 *
 * No new delivery path: artifacts and canvas documents become the same
 * context chip `@artifact:` / `@canvas:` stages, and images / files are
 * appended to the target conversation's draft exactly as a restored draft
 * attachment — the composer re-stages them from `bytes` with the cached
 * extraction when that conversation opens, and storage dedups on send
 * (`putSessionAsset` / `ingestImage` skip bytes they already hold).
 *
 * A source too large for a composer draft is bound to the conversation as a
 * session asset instead (no bytes copied); the agent reads it through the
 * attachment tools.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { AttachmentExtractedContent } from "@cognia/agent-config-types/attachment"
import { readBlobAsArrayBuffer } from "@cognia/ocr/blob-utils"
import {
  entitySelectionFrom,
  getEntityMentionSource,
  type EntityMentionCandidate,
} from "@/lib/chat/mentions/entity-sources"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"
import {
  DRAFT_ATTACHMENT_QUOTA_BYTES,
  getDraft,
  setDraft,
  type DraftAttachmentMeta,
} from "@/lib/db/chat-drafts"
import { getManyMessageMedia } from "@/lib/db/message-media"
import {
  bindHeldSessionAsset,
  getHeldSessionAssetSource,
  getLibraryAsset,
  getSessionAssetMetadata,
  hashSessionAssetSource,
} from "@/lib/db/session-assets"
import { createSession, getSession } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import type { FilesEntry } from "./types"

export class FilesUseInChatError extends Error {
  constructor(
    readonly code: "files_source_missing" | "files_not_attachable" | "files_source_empty"
  ) {
    super(code)
    this.name = "FilesUseInChatError"
  }
}

/** The chip an artifact / canvas document is staged as. */
export function mentionCandidateFor(entry: FilesEntry): EntityMentionCandidate | null {
  if (entry.kind !== "artifact" && entry.kind !== "canvas") return null
  return {
    entityKind: entry.kind,
    id: entry.sourceId,
    title: entry.title,
    searchText: "",
    ...(entry.subtype
      ? { subtitle: entry.language ? `${entry.subtype} · ${entry.language}` : entry.subtype }
      : {}),
  }
}

/**
 * Stage an artifact / canvas document as a context chip in `sessionId`'s
 * composer — the same snapshot, fingerprint and selection shape the `@` panel
 * produces (`useEntityMentionStaging`), addressed to a named conversation
 * because no composer is focused while Files is open.
 */
export async function stageEntryMention(entry: FilesEntry, sessionId: string): Promise<void> {
  const candidate = mentionCandidateFor(entry)
  if (!candidate) throw new FilesUseInChatError("files_not_attachable")
  const source = getEntityMentionSource(candidate.entityKind)
  if (!source) throw new FilesUseInChatError("files_not_attachable")
  const body = await source.snapshot(candidate)
  if (body === null) throw new FilesUseInChatError("files_source_missing")
  if (!body.trim()) throw new FilesUseInChatError("files_source_empty")
  const fingerprint = source.fingerprint
    ? await source.fingerprint(candidate).catch(() => undefined)
    : undefined
  const selection = entitySelectionFrom(candidate, body, { fingerprint: fingerprint ?? undefined })
  useChatStore.getState().addContextSelection(selection, sessionId)
  void trackEvent("chat.reference.staged", { entityKind: candidate.entityKind, via: "surface" })
}

function isWritable(session: ChatSession): boolean {
  try {
    assertSessionWritable(session, "send-message")
    return true
  } catch {
    return false
  }
}

/**
 * The conversation to use: the active one when it exists and accepts a new
 * message, otherwise a new conversation titled `newTitle`.
 */
export async function resolveUseInChatTarget(
  newTitle: string
): Promise<{ session: ChatSession; created: boolean }> {
  const activeId = useChatStore.getState().activeSessionId
  if (activeId) {
    const active = await getSession(activeId)
    if (active && isWritable(active)) return { session: active, created: false }
  }
  return { session: await createSession({ title: newTitle }), created: true }
}

interface HeldSource {
  blob: Blob
  name: string
  mediaType: string
  extractedContent?: AttachmentExtractedContent
  contentHash?: string
}

function extensionFor(mediaType: string): string {
  const subtype = mediaType.split("/")[1]?.split("+")[0]?.toLowerCase()
  if (!subtype) return "bin"
  return subtype === "jpeg" ? "jpg" : subtype
}

async function loadHeldSource(entry: FilesEntry): Promise<HeldSource> {
  if (entry.kind === "image") {
    const [row] = await getManyMessageMedia([entry.sourceId])
    if (!row) throw new FilesUseInChatError("files_source_missing")
    const mediaType = row.originalBlob ? (row.originalMediaType ?? row.mediaType) : row.mediaType
    return {
      blob: row.originalBlob ?? row.blob,
      mediaType,
      name: entry.title || `image-${entry.sourceId.slice(0, 8)}.${extensionFor(mediaType)}`,
    }
  }
  if (entry.kind === "upload") {
    const asset = await getLibraryAsset(entry.sourceId)
    if (!asset) throw new FilesUseInChatError("files_source_missing")
    return {
      blob: asset.blob,
      name: asset.filename,
      mediaType: asset.mediaType,
      contentHash: asset.contentHash,
      ...(asset.extractedContent ? { extractedContent: asset.extractedContent } : {}),
    }
  }
  if (entry.kind === "session-upload") {
    const blob = await getHeldSessionAssetSource(entry.sourceId)
    if (!blob) throw new FilesUseInChatError("files_source_missing")
    const metadata =
      entry.assetSessionId && entry.assetId
        ? await getSessionAssetMetadata(entry.assetSessionId, entry.assetId)
        : undefined
    return {
      blob,
      name: entry.title || metadata?.filename || `file.${extensionFor(entry.mediaType ?? "")}`,
      mediaType: entry.mediaType ?? metadata?.mediaType ?? "application/octet-stream",
      contentHash: entry.sourceId,
      ...(metadata?.extractedContent ? { extractedContent: metadata.extractedContent } : {}),
    }
  }
  throw new FilesUseInChatError("files_not_attachable")
}

function newAssetId(): string {
  return `asset-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`
}

/**
 * Put an image or file into `sessionId`'s next message. Returns `"draft"` when
 * it was staged in the draft, `"bound"` when it was too large for a draft and
 * was attached to the conversation as a session asset instead.
 */
export async function attachEntryToSession(
  entry: FilesEntry,
  sessionId: string
): Promise<"draft" | "bound"> {
  const source = await loadHeldSource(entry)
  if (source.blob.size > DRAFT_ATTACHMENT_QUOTA_BYTES) {
    if (!source.contentHash) throw new FilesUseInChatError("files_not_attachable")
    const assetId = newAssetId()
    await bindHeldSessionAsset({
      sessionId,
      assetId,
      contentHash: source.contentHash,
      filename: source.name,
      mediaType: source.mediaType,
      ...(source.extractedContent
        ? { extractedContent: { ...source.extractedContent, attachmentId: assetId } }
        : {}),
    })
    return "bound"
  }
  const bytes = new Uint8Array(await readBlobAsArrayBuffer(source.blob))
  const hash = source.contentHash ?? (await hashSessionAssetSource(source.blob))
  const draft = await getDraft(sessionId)
  const attachments = draft?.attachments ?? []
  // Using the same file twice stages it once.
  if (attachments.some((attachment) => attachment.hash === hash)) return "draft"
  const meta: DraftAttachmentMeta = {
    name: source.name,
    mediaType: source.mediaType,
    size: source.blob.size,
    bytes,
    hash,
    ...(source.extractedContent ? { extractedContent: source.extractedContent } : {}),
  }
  await setDraft(sessionId, draft?.text ?? "", [...attachments, meta])
  return "draft"
}
