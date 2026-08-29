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
import type { CollabClient } from "./client"

type SharedChatConversionClient = Pick<
  CollabClient,
  "identity" | "createSharedSession" | "appendSessionEvent" | "updateSharedSession"
>

export interface SharedChatConversionInput {
  localSessionId: string
  orgId: string
  workspaceId: string
  /** Uploads local file parts and returns parts containing server-safe references. */
  prepareAttachmentParts?: (message: StoredMessage) => Promise<StoredMessage["parts"]>
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
  const { session: local, messages } = await readSource(input.localSessionId)
  const files = attachmentCount(messages)
  if (files > 0 && !input.prepareAttachmentParts) {
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
    const parts = hasFilePart(message)
      ? await input.prepareAttachmentParts!(message)
      : message.parts
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
