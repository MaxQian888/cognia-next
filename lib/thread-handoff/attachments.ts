import type { CanonicalTurn } from "@cognia/agent-config-types/canonical-session"
import type {
  ThreadHandoffAttachment,
  ThreadHandoffTicket,
} from "@cognia/agent-config-types/thread-handoff"
import { readBlobAsArrayBuffer } from "@cognia/ocr/blob-utils"
import { sha256Bytes } from "@/lib/ocr/hash"
import { getMessageMedia, parseMediaRef, putMessageMedia } from "@/lib/db/message-media"
import { resolveAttachmentRef } from "@/lib/db/session-attachment-uploads"
import { getDb } from "@/lib/db/schema"
import { uploadSessionAttachment } from "@/lib/companion/attachment-upload-client"
import type { Transport } from "@/lib/tauri/transport-types"

async function readAttachment(
  ref: string,
  sessionId: string
): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
  const hash = parseMediaRef(ref)
  if (hash) {
    const row = await getMessageMedia(hash)
    if (!row || row.canonicalAvailable === false) return null
    return {
      bytes: new Uint8Array(await readBlobAsArrayBuffer(row.blob)),
      mediaType: row.mediaType,
    }
  }
  const upload = await resolveAttachmentRef(ref, { sessionId })
  return upload?.bytes ? { bytes: upload.bytes, mediaType: upload.mediaType } : null
}

/** Derive the manifest from actual canonical bytes, never from unverified metadata. */
export async function buildThreadHandoffAttachments(
  turns: readonly CanonicalTurn[],
  sessionId: string
): Promise<ThreadHandoffAttachment[]> {
  const manifest = new Map<string, ThreadHandoffAttachment>()
  for (const turn of turns) {
    for (const part of [
      ...(turn.parts ?? []),
      ...(turn.toolCalls ?? []).flatMap((call) => call.attachments ?? []),
    ]) {
      if (part.type !== "file") continue
      let attachment = manifest.get(part.uri)
      if (!attachment) {
        const data = await readAttachment(part.uri, sessionId)
        if (!data) throw new Error("thread_handoff_attachment_unresolvable")
        const digest = await sha256Bytes(data.bytes)
        let canonicalRef = part.uri
        if (!parseMediaRef(canonicalRef)) {
          const now = Date.now()
          canonicalRef = await putMessageMedia({
            hash: digest,
            blob: new Blob([data.bytes as BlobPart], { type: data.mediaType }),
            mediaType: data.mediaType,
            byteSize: data.bytes.byteLength,
            width: 0,
            height: 0,
            canonicalAvailable: true,
            createdAt: now,
            lastUsedAt: now,
          })
        }
        attachment = {
          attachmentId: canonicalRef,
          ref: canonicalRef,
          filename: part.name,
          mediaType: data.mediaType,
          byteLength: data.bytes.byteLength,
          digest,
          carriage: "by-ref",
        }
        manifest.set(part.uri, attachment)
      }
      part.uri = attachment.attachmentId
      const hash = parseMediaRef(part.uri)
      if (hash) {
        // The paired-device binary route authorizes reads through this source
        // session index, including temporary uploads promoted during export.
        await getDb().messageMediaRefs.put({ messageId: turn.turnId, sessionId, hash })
      }
      part.digest = attachment.digest
      part.size = attachment.byteLength
      part.mediaType = attachment.mediaType
    }
  }
  return [...manifest.values()]
}

function handoffAttachmentScope(
  ticket: ThreadHandoffTicket,
  attachment: ThreadHandoffAttachment
): string {
  return `thread-handoff:${ticket.ticketId}:${attachment.digest}`
}

export async function verifiedThreadHandoffAttachmentRefs(
  ticket: ThreadHandoffTicket
): Promise<string[]> {
  const verified: string[] = []
  for (const attachment of ticket.attachments) {
    if (!attachment.ref) continue
    const data =
      (await readAttachment(
        attachment.attachmentId,
        ticket.target.sessionId ?? ticket.source.sessionId
      )) ??
      (await readAttachment(attachment.ref, ticket.target.sessionId ?? ticket.source.sessionId)) ??
      (await readAttachment(attachment.ref, handoffAttachmentScope(ticket, attachment)))
    if (
      data &&
      data.bytes.byteLength === attachment.byteLength &&
      data.mediaType === attachment.mediaType &&
      (await sha256Bytes(data.bytes)) === attachment.digest
    ) {
      const hash = parseMediaRef(attachment.attachmentId)
      if (hash && attachment.ref !== attachment.attachmentId) {
        const now = Date.now()
        await putMessageMedia({
          hash,
          mediaType: data.mediaType,
          blob: new Blob([data.bytes as BlobPart], { type: data.mediaType }),
          byteSize: data.bytes.byteLength,
          width: 0,
          height: 0,
          canonicalAvailable: true,
          createdAt: now,
          lastUsedAt: now,
        })
      }
      verified.push(attachment.ref)
    }
  }
  return verified
}

/** The existing authenticated, session-scoped binary transport carries canonical media. */
export async function receiveThreadHandoffAttachments(
  ticket: ThreadHandoffTicket,
  transport: Transport
): Promise<void> {
  const existing = new Set(await verifiedThreadHandoffAttachmentRefs(ticket))
  for (const attachment of ticket.attachments) {
    if (attachment.ref && existing.has(attachment.ref)) continue
    const hash = parseMediaRef(attachment.ref)
    if (!hash || !transport.readBinary) throw new Error("thread_handoff_attachment_unresolvable")
    const data = await transport.readBinary({
      kind: "session-media",
      sessionId: ticket.source.sessionId,
      hash,
      variant: "canonical",
    })
    if (
      data.bytes.byteLength !== attachment.byteLength ||
      data.mediaType !== attachment.mediaType ||
      (await sha256Bytes(data.bytes)) !== attachment.digest
    )
      throw new Error("thread_handoff_attachment_integrity_failed")
    const now = Date.now()
    await putMessageMedia({
      hash,
      mediaType: data.mediaType,
      blob: new Blob([data.bytes as BlobPart], { type: data.mediaType }),
      byteSize: data.bytes.byteLength,
      width: 0,
      height: 0,
      canonicalAvailable: true,
      createdAt: now,
      lastUsedAt: now,
    })
  }
}

/** Stage through the target's resumable upload protocol; source URIs and sequence digest stay stable. */
export async function stageRemoteThreadHandoffAttachments(
  ticket: ThreadHandoffTicket,
  transport: Transport
): Promise<ThreadHandoffAttachment[]> {
  const staged: ThreadHandoffAttachment[] = []
  for (const attachment of ticket.attachments) {
    const data = await readAttachment(attachment.attachmentId, ticket.source.sessionId)
    if (
      !data ||
      data.bytes.byteLength !== attachment.byteLength ||
      (await sha256Bytes(data.bytes)) !== attachment.digest
    ) {
      throw new Error("thread_handoff_attachment_integrity_failed")
    }
    // Each historical artifact has a stable staging scope. A conversation can
    // contain more than the composer's six concurrently staged attachments.
    const uploaded = await uploadSessionAttachment(
      handoffAttachmentScope(ticket, attachment),
      { name: attachment.filename, mediaType: data.mediaType, bytes: data.bytes },
      {
        hash: attachment.digest,
        call: (name, args) => transport.call(name, args),
      }
    )
    if (
      uploaded.hash !== attachment.digest ||
      uploaded.size !== attachment.byteLength ||
      uploaded.mediaType !== attachment.mediaType
    ) {
      throw new Error("thread_handoff_attachment_integrity_failed")
    }
    staged.push({ ...attachment, ref: uploaded.ref })
  }
  return staged
}
