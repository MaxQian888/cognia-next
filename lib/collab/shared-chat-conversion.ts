import type {
  AuthorRef,
  ChatSession,
  SessionEvent,
  SharedSession,
  StoredMessage,
} from "@cognia/agent-config-types"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"
import { appendCollabChatEvents, sharedChatCacheKey } from "@/lib/db/collab-chat-mirror"
import { getDb } from "@/lib/db/schema"
import { assertFetchTargetAllowed } from "@/lib/web/fetch-guard"
import { bytesToBase64 } from "@/lib/ocr/image-prep"
import { getMessageMedia, parseMediaRef } from "@/lib/db/message-media"
import type { CollabClient } from "./client"
import { assertSharedChatClientEnabled } from "./shared-chat-feature"

type SharedChatConversionClient = { readonly baseUrl?: string } & Pick<
  CollabClient,
  "identity" | "createSharedSession" | "appendSessionEvent" | "updateSharedSession"
> &
  Partial<
    Pick<
      CollabClient,
      "initializeSessionAttachment" | "uploadSessionAttachment" | "commitSessionAttachment"
    >
  >

export async function resolveSharedAttachmentParts(
  client: Pick<CollabClient, "createSessionAttachmentDownloadTicket" | "downloadSessionAttachment">,
  orgId: string,
  sessionId: string,
  parts: StoredMessage["parts"]
): Promise<StoredMessage["parts"]> {
  return Promise.all(
    parts.map(async (part) => {
      if (
        part.type !== "file" ||
        typeof part.url !== "string" ||
        !part.url.startsWith("cognia://shared-attachment/")
      )
        return part
      const id = part.url.slice("cognia://shared-attachment/".length)
      const grant = await client.createSessionAttachmentDownloadTicket(orgId, sessionId, id)
      const attachment = grant.attachment
      if (
        attachment.id !== id ||
        attachment.sessionId !== sessionId ||
        ("orgId" in attachment && attachment.orgId !== orgId) ||
        attachment.status !== "available"
      ) {
        throw new Error("Shared attachment scope mismatch")
      }
      const blob = await client.downloadSessionAttachment(orgId, id, grant.ticket)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (
        bytes.byteLength !== attachment.byteLength ||
        (await sha256Hex(bytes)) !== attachment.sha256
      ) {
        throw new Error("Shared attachment integrity mismatch")
      }
      return {
        ...part,
        mediaType: attachment.mediaType,
        url: `data:${attachment.mediaType};base64,${bytesToBase64(bytes)}`,
      }
    })
  )
}

export interface SharedChatConversionInput {
  localSessionId: string
  orgId: string
  workspaceId: string
  /** Uploads local file parts and returns parts containing server-safe references. */
  prepareAttachmentParts?: (
    message: StoredMessage,
    sharedSession: SharedSession
  ) => Promise<StoredMessage["parts"]>
  readAttachment?: (part: StoredMessage["parts"][number]) => Promise<Uint8Array>
}

export interface SharedChatConversionResult {
  session: SharedSession
  importedMessageCount: number
  importedAttachmentCount: number
}

/**
 * A character-team room cannot be converted, yet.
 *
 * Conversion leaves `kind: "team"` and `teamId` on the local row and adds
 * `collaboration` beside them, which makes the session two things at once:
 * `desktop-chat-workspace` still routes its sends to `useTeamChat`, which
 * writes messages straight to Dexie, while `shared-chat-sync` pulls the
 * server's events into the same list. Nothing reconciles the two, so the local
 * members keep answering and no one else in the shared session ever sees it.
 *
 * Failing here is the honest outcome until a shared session can carry a team
 * (which needs `shared-run-coordinator` to accept that one turn produces N
 * agent messages rather than one). Silently half-working is worse than a
 * refusal that says what is missing.
 */
export class SharedChatTeamSessionUnsupportedError extends Error {
  constructor() {
    super("A team conversation cannot be shared yet")
    this.name = "SharedChatTeamSessionUnsupportedError"
  }
}

export class SharedChatAttachmentImportRequiredError extends Error {
  constructor(readonly attachmentCount: number) {
    super("Shared chat conversion requires an attachment importer")
    this.name = "SharedChatAttachmentImportRequiredError"
  }
}

function hasFilePart(message: StoredMessage): boolean {
  return message.parts.some((part) => part.type === "file")
}

function attachmentCount(messages: readonly StoredMessage[]): number {
  return messages.reduce(
    (count, message) => count + message.parts.filter((part) => part.type === "file").length,
    0
  )
}

function authorFor(message: StoredMessage, importerUserId: string): AuthorRef {
  if (message.collaboration?.author) return message.collaboration.author
  if (message.role === "assistant") {
    return { kind: "agent", id: message.senderId ?? "assistant", source: "local-import" }
  }
  if (message.role === "system") return { kind: "system", id: "system", source: "local-import" }
  return { kind: "human", id: message.senderId ?? importerUserId, source: "local-import" }
}

function operationPrefix(localSessionId: string): string {
  return `chat-import:${localSessionId}`
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * In-process attachment references: the bytes are already on this machine, so
 * resolving one reaches no network and needs no guard.
 */
const LOCAL_ATTACHMENT_SCHEMES = ["data:", "blob:"]

/**
 * Read one local attachment's bytes for upload.
 *
 * `part.url` is NOT trustworthy. Session rows reach Dexie from the external
 * agent importers (`lib/session-import/adapters/*`), where the url is whatever
 * the foreign transcript carried — OpenCode alone can produce a remote
 * `source.url` or a bare filesystem path. Converting such a session to shared
 * would otherwise make the authenticated webview fetch an attacker-chosen
 * origin and upload the response to the collab server.
 *
 * `data:`/`blob:` resolve locally and pass. Everything else goes through the
 * shared SSRF floor (`@cognia/network-guard` via `lib/web/fetch-guard`), which
 * permits only public http(s) — no loopback, LAN, or cloud metadata.
 */
async function defaultReadAttachment(part: StoredMessage["parts"][number]): Promise<Uint8Array> {
  if (part.type !== "file") throw new Error("Only file parts can be uploaded")
  if (parseMediaRef(part.url)) {
    const media = await getMessageMedia(part.url)
    if (!media) throw new Error("Local attachment could not be read")
    return new Uint8Array(await media.blob.arrayBuffer())
  }
  if (!LOCAL_ATTACHMENT_SCHEMES.some((scheme) => part.url.startsWith(scheme))) {
    assertFetchTargetAllowed(part.url)
  }
  const response = await fetch(part.url)
  if (!response.ok) throw new Error("Local attachment could not be read")
  return new Uint8Array(await response.arrayBuffer())
}

export async function uploadMessageAttachments(
  client: SharedChatConversionClient,
  input: SharedChatConversionInput,
  remote: SharedSession,
  message: StoredMessage
): Promise<{ parts: StoredMessage["parts"]; attachmentIds: string[] }> {
  const sourceDb = getDb()
  const assertCurrentAccount = () => {
    if (getDb() !== sourceDb)
      throw new DOMException("Shared attachment upload cancelled", "AbortError")
  }
  if (input.prepareAttachmentParts) {
    const parts = await input.prepareAttachmentParts(message, remote)
    assertCurrentAccount()
    return {
      parts,
      attachmentIds: [],
    }
  }
  if (
    !client.initializeSessionAttachment ||
    !client.uploadSessionAttachment ||
    !client.commitSessionAttachment
  ) {
    throw new SharedChatAttachmentImportRequiredError(attachmentCount([message]))
  }
  const readAttachment = input.readAttachment ?? defaultReadAttachment
  const attachmentIds: string[] = []
  const parts: StoredMessage["parts"] = []
  for (const part of message.parts) {
    assertCurrentAccount()
    if (
      part.type !== "file" ||
      typeof (part as { text?: unknown }).text === "string" ||
      part.url?.startsWith("cognia://shared-attachment/")
    ) {
      parts.push(part)
      continue
    }
    const bytes = await readAttachment(part)
    assertCurrentAccount()
    const initialized = await client.initializeSessionAttachment(input.orgId, remote.id, {
      fileName: part.filename ?? "attachment",
      mediaType: part.mediaType,
      byteLength: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    })
    assertCurrentAccount()
    await client.uploadSessionAttachment(
      input.orgId,
      initialized.attachment.id,
      initialized.ticket,
      bytes
    )
    assertCurrentAccount()
    attachmentIds.push(initialized.attachment.id)
    parts.push({ ...part, url: `cognia://shared-attachment/${initialized.attachment.id}` })
  }
  return { parts, attachmentIds }
}

async function readSource(localSessionId: string): Promise<{
  session: ChatSession
  messages: StoredMessage[]
}> {
  const db = getDb()
  const session = await db.sessions.get(localSessionId)
  if (!session) throw new Error(`Local session ${localSessionId} does not exist`)
  assertSessionWritable(session, "metadata")
  if (session.collaboration) throw new Error("Session is already shared")
  const messages = await db.messages
    .where("[sessionId+createdAt]")
    .between([localSessionId, 0], [localSessionId, Number.MAX_SAFE_INTEGER])
    .sortBy("createdAt")
  return { session, messages }
}

export async function convertLocalSessionToShared(
  client: SharedChatConversionClient,
  input: SharedChatConversionInput
): Promise<SharedChatConversionResult> {
  assertSharedChatClientEnabled()
  const db = getDb()
  const { session: local, messages } = await readSource(input.localSessionId)
  if (local.kind === "team") throw new SharedChatTeamSessionUnsupportedError()
  const files = attachmentCount(messages)
  if (
    files > 0 &&
    !input.prepareAttachmentParts &&
    (!client.initializeSessionAttachment ||
      !client.uploadSessionAttachment ||
      !client.commitSessionAttachment)
  ) {
    throw new SharedChatAttachmentImportRequiredError(files)
  }

  const identity = await client.identity(input.orgId)
  if (getDb() !== db) throw new DOMException("Shared conversion cancelled", "AbortError")
  const prefix = operationPrefix(local.id)
  const remoteDraft = await client.createSharedSession(input.orgId, input.workspaceId, {
    title: local.title,
    importing: true,
    operationId: `${prefix}:create`,
  })

  const imported: Array<{
    source: StoredMessage
    event: SessionEvent
    parts: StoredMessage["parts"]
  }> = []
  for (const message of messages) {
    if (getDb() !== db) throw new DOMException("Shared conversion cancelled", "AbortError")
    const uploaded = hasFilePart(message)
      ? await uploadMessageAttachments(client, input, remoteDraft, message)
      : { parts: message.parts, attachmentIds: [] }
    const parts = uploaded.parts
    if (getDb() !== db) throw new DOMException("Shared conversion cancelled", "AbortError")
    const author = authorFor(message, identity.userId)
    const event = await client.appendSessionEvent(input.orgId, remoteDraft.id, {
      kind: "message.created",
      operationId: `${prefix}:message:${message.id}`,
      actorLabel: author.displayName,
      payload: {
        messageId: message.id,
        role: message.role,
        parts,
        createdAt: message.createdAt,
        author,
        imported: true,
      },
    })
    if (getDb() !== db) throw new DOMException("Shared conversion cancelled", "AbortError")
    await Promise.all(
      uploaded.attachmentIds.map((attachmentId) =>
        client.commitSessionAttachment!(input.orgId, remoteDraft.id, attachmentId, event.id)
      )
    )
    imported.push({ source: message, event, parts })
  }

  if (getDb() !== db) throw new DOMException("Shared conversion cancelled", "AbortError")
  const active = await client.updateSharedSession(input.orgId, remoteDraft.id, {
    status: "active",
    operationId: `${prefix}:activate`,
    baseRevision: remoteDraft.revision,
  })
  const cursor = imported.at(-1)?.event.sequence ?? 0

  if (getDb() !== db) throw new DOMException("Shared conversion cancelled", "AbortError")
  await db.transaction("rw", db.sessions, db.messages, db.collabChatEvents, async () => {
    const current = await db.sessions.get(local.id)
    if (!current) throw new Error(`Local session ${local.id} disappeared during conversion`)
    assertSessionWritable(current, "metadata")
    if (current.collaboration) throw new Error("Session became shared during conversion")

    for (const row of imported) {
      await db.messages.update(row.source.id, {
        // Keep the importing device's verified local media references renderable.
        // Other participants resolve the server references when projecting events.
        parts: row.source.parts,
        collaboration: {
          remoteMessageId: row.source.id,
          author: authorFor(row.source, identity.userId),
          sourceEventId: row.event.id,
          eventSequence: row.event.sequence,
          version: 1,
        },
      })
    }
    await db.sessions.update(local.id, {
      collaboration: {
        ...(client.baseUrl ? { endpoint: client.baseUrl } : {}),
        orgId: active.orgId,
        workspaceId: active.workspaceId,
        sessionId: active.id,
        policyRevision: active.policyRevision,
        syncCursor: cursor,
      },
      updatedAt: Date.now(),
    })
    const cacheKey = sharedChatCacheKey(input.orgId, active.id, client.baseUrl)
    await appendCollabChatEvents(
      imported.map(({ event }) => ({
        ...event,
        id: `${cacheKey}:event:${event.id}`,
        sessionId: cacheKey,
        orgId: input.orgId,
        fetchedAt: Date.now(),
      }))
    )
  })

  return {
    session: active,
    importedMessageCount: imported.length,
    importedAttachmentCount: files,
  }
}
