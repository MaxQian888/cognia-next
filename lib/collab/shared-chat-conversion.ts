import type {
  AuthorRef,
  ChatSession,
  SessionEvent,
  SharedSession,
  StoredMessage,
} from "@cognia/agent-config-types"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"
import { appendCollabChatEvents } from "@/lib/db/collab-chat-mirror"
import { getDb } from "@/lib/db/schema"
import { assertFetchTargetAllowed } from "@/lib/web/fetch-guard"
import type { CollabClient } from "./client"
import { assertSharedChatClientEnabled } from "./shared-chat-feature"

type SharedChatConversionClient = Pick<
  CollabClient,
  "identity" | "createSharedSession" | "appendSessionEvent" | "updateSharedSession"
> &
  Partial<
    Pick<
      CollabClient,
      "initializeSessionAttachment" | "uploadSessionAttachment" | "commitSessionAttachment"
    >
  >

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
  if (!LOCAL_ATTACHMENT_SCHEMES.some((scheme) => part.url.startsWith(scheme))) {
    assertFetchTargetAllowed(part.url)
  }
  const response = await fetch(part.url)
  if (!response.ok) throw new Error("Local attachment could not be read")
  return new Uint8Array(await response.arrayBuffer())
}

async function uploadMessageAttachments(
  client: SharedChatConversionClient,
  input: SharedChatConversionInput,
  remote: SharedSession,
  message: StoredMessage
): Promise<{ parts: StoredMessage["parts"]; attachmentIds: string[] }> {
  if (input.prepareAttachmentParts) {
    return {
      parts: await input.prepareAttachmentParts(message, remote),
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
    if (part.type !== "file") {
      parts.push(part)
      continue
    }
    const bytes = await readAttachment(part)
    const initialized = await client.initializeSessionAttachment(input.orgId, remote.id, {
      fileName: part.filename ?? "attachment",
      mediaType: part.mediaType,
      byteLength: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    })
    await client.uploadSessionAttachment(
      input.orgId,
      initialized.attachment.id,
      initialized.ticket,
      bytes
    )
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
  const { session: local, messages } = await readSource(input.localSessionId)
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
    const uploaded = hasFilePart(message)
      ? await uploadMessageAttachments(client, input, remoteDraft, message)
      : { parts: message.parts, attachmentIds: [] }
    const parts = uploaded.parts
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
    await Promise.all(
      uploaded.attachmentIds.map((attachmentId) =>
        client.commitSessionAttachment!(input.orgId, remoteDraft.id, attachmentId, event.id)
      )
    )
    imported.push({ source: message, event, parts })
  }

  const active = await client.updateSharedSession(input.orgId, remoteDraft.id, {
    status: "active",
    operationId: `${prefix}:activate`,
    baseRevision: remoteDraft.revision,
  })
  const cursor = imported.at(-1)?.event.sequence ?? 0

  const db = getDb()
  await db.transaction("rw", db.sessions, db.messages, async () => {
    const current = await db.sessions.get(local.id)
    if (!current) throw new Error(`Local session ${local.id} disappeared during conversion`)
    assertSessionWritable(current, "metadata")
    if (current.collaboration) throw new Error("Session became shared during conversion")

    for (const row of imported) {
      await db.messages.update(row.source.id, {
        parts: row.parts,
        collaboration: {
          author: authorFor(row.source, identity.userId),
          sourceEventId: row.event.id,
          eventSequence: row.event.sequence,
          version: 1,
        },
      })
    }
    await db.sessions.update(local.id, {
      collaboration: {
        orgId: active.orgId,
        workspaceId: active.workspaceId,
        sessionId: active.id,
        policyRevision: active.policyRevision,
        syncCursor: cursor,
      },
      updatedAt: Date.now(),
    })
  })
  await appendCollabChatEvents(
    imported.map(({ event }) => ({ ...event, orgId: input.orgId, fetchedAt: Date.now() }))
  )

  return {
    session: active,
    importedMessageCount: imported.length,
    importedAttachmentCount: files,
  }
}
