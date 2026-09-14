/**
 * Text selected inside the transcript, as a staged reference.
 *
 * A `@msg:` reference is a whole message. What a person selects is usually one
 * sentence of it, or a code block — and the capsule's summarize / explain /
 * translate produce text about exactly that part. Both are staged here as a
 * `message` entity reference with an `excerpt`, so they reuse everything a
 * message reference already has: the chip, the permalink, the backlink citation
 * per message, the untrusted-content wrapper and the staleness check.
 *
 * A selection that runs across turns names every message it touches as a member.
 * The chip stays one chip, each message is cited, and the reference goes stale
 * when any of them is edited.
 */

import type {
  EntityExcerpt,
  EntityReferenceMember,
  EntitySelectionRef,
} from "@/types/artifact/artifact"
import {
  entitySnapshotBody,
  fingerprintEntityRecords,
  referencedEntityIds,
} from "@/lib/chat/mentions/entity-sources"
import {
  messageRefId,
  parseMessageRefId,
  projectMessageBody,
} from "@/lib/chat/mentions/message-reference"
import { messagePermalinkQuery } from "@/lib/chat/message-permalink"
import { selectionTitleFor } from "./selection-text"

/** How much of a member message names it in the chip's expanded list. */
export const EXCERPT_MEMBER_TITLE_MAX = 60

export interface MessageExcerptInput {
  /** The conversation the selection was made in. */
  sessionId: string
  /** Every message the selection touches, in transcript order. */
  messageIds: readonly string[]
  /** The body to stage: the selection itself for a quote, the generated text otherwise. */
  text: string
  excerpt: EntityExcerpt
  /** Defaults to now. Injectable so a test can pin it. */
  capturedAt?: number
}

interface StoredMessage {
  id: string
  sessionId: string
  role: string
  parts: unknown
}

/** The in-app permalink that lands on one message. */
export function messageExcerptHref(sessionId: string, messageId: string): string {
  return `/${messagePermalinkQuery({ sessionId, messageId })}`
}

async function loadMessages(
  sessionId: string,
  messageIds: readonly string[]
): Promise<(StoredMessage | null)[]> {
  const { getDb } = await import("@/lib/db/schema")
  const rows = (await getDb().messages.bulkGet([...messageIds])) as (StoredMessage | undefined)[]
  // A row that belongs to another conversation is not this selection's message,
  // whatever its id says.
  return rows.map((row) => (row && row.sessionId === sessionId ? row : null))
}

/**
 * The stored text of the messages a selection touches, in order — what an
 * explanation reads as context. Reads the rows rather than the rendered DOM,
 * whose text also carries timestamps and button labels. Null when none of them
 * is stored yet (a reply still streaming), so the caller can fall back.
 */
export async function loadMessageBodies(
  sessionId: string,
  messageIds: readonly string[]
): Promise<string | null> {
  if (messageIds.length === 0) return null
  const rows = await loadMessages(sessionId, messageIds)
  const bodies = rows.flatMap((row) => {
    const body = row ? projectMessageBody(row.parts) : ""
    return body ? [body] : []
  })
  return bodies.length > 0 ? bodies.join("\n\n") : null
}

function memberTitle(row: StoredMessage | null, messageId: string): string {
  if (!row) return messageId
  const body = projectMessageBody(row.parts)
  return body ? `${row.role}: ${selectionTitleFor(body, EXCERPT_MEMBER_TITLE_MAX)}` : row.role
}

/**
 * A fingerprint worth storing, or undefined when the check would be meaningless.
 *
 * A message still being streamed may not be stored yet. Recording its absence
 * would mark the chip stale the moment the row lands, for a change the user
 * never made — so an incomplete read stores nothing, and the chip is simply
 * un-checkable.
 */
function storableFingerprint(value: string | null | undefined): string | undefined {
  if (value == null) return undefined
  return value.split("\n").includes("∅") ? undefined : value
}

/**
 * Build the staged reference, or null when there is nothing to stage (no body,
 * or no message to attach it to).
 */
export async function buildMessageExcerptSelection(
  input: MessageExcerptInput
): Promise<EntitySelectionRef | null> {
  const messageIds = [...new Set(input.messageIds)]
  const body = input.text.trim()
  if (messageIds.length === 0 || !body || !input.excerpt.quote.trim()) return null

  const refIds = messageIds.map((id) => messageRefId(input.sessionId, id))
  const [rows, fingerprint] = await Promise.all([
    messageIds.length > 1 ? loadMessages(input.sessionId, messageIds) : Promise.resolve([]),
    fingerprintEntityRecords("message", refIds).catch(() => undefined),
  ])
  const members: EntityReferenceMember[] | undefined =
    messageIds.length > 1
      ? messageIds.map((id, index) => ({
          entityId: refIds[index]!,
          title: memberTitle(rows[index] ?? null, id),
          href: messageExcerptHref(input.sessionId, id),
        }))
      : undefined
  const stored = storableFingerprint(fingerprint)

  return {
    kind: "entity",
    entityKind: "message",
    entityId: refIds[0]!,
    title: selectionTitleFor(input.excerpt.quote),
    snapshot: entitySnapshotBody("message", body),
    comment: "",
    capturedAt: input.capturedAt ?? Date.now(),
    ...(stored !== undefined ? { fingerprint: stored } : {}),
    href: messageExcerptHref(input.sessionId, messageIds[0]!),
    sourceSessionId: input.sessionId,
    ...(members ? { members } : {}),
    excerpt: input.excerpt,
  }
}

/**
 * Letters and digits only, case-folded and compatibility-normalized.
 *
 * A selection is copied off the RENDERED message, and a message is stored as
 * Markdown: `**bold**` selects as `bold`, a link selects as its text, a list
 * loses its markers. What the two reliably share is the words, so that is what
 * is compared.
 */
export function comparableExcerptText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
}

export type MessageExcerptRefresh =
  /** The selected text is still there. The reference carries a fresh fingerprint. */
  | { kind: "current"; selection: EntitySelectionRef }
  /** The message was edited and no longer says what was selected. */
  | { kind: "changed" }
  /** A message the selection was made in is gone. */
  | { kind: "gone" }

/**
 * Re-check an excerpt against its messages as they are now.
 *
 * Deliberately NOT a re-read. Re-reading a message reference replaces its body
 * with the message's; an excerpt's body is a part the user chose (or text
 * generated from that part), and the message cannot say which part that was.
 * So the only honest refresh is: is the selected text still there? If so the
 * body stands and only the fingerprint moves. If not, the caller says so and
 * the chip stays marked.
 */
export async function refreshMessageExcerpt(
  selection: EntitySelectionRef & { excerpt: EntityExcerpt }
): Promise<MessageExcerptRefresh> {
  const refs = referencedEntityIds(selection).map(parseMessageRefId)
  if (refs.some((ref) => ref === null)) return { kind: "gone" }
  const parsed = refs as { sessionId: string; messageId: string }[]
  const sessionId = parsed[0]!.sessionId
  if (parsed.some((ref) => ref.sessionId !== sessionId)) return { kind: "gone" }

  const rows = await loadMessages(
    sessionId,
    parsed.map((ref) => ref.messageId)
  )
  if (rows.some((row) => row === null)) return { kind: "gone" }

  const haystack = comparableExcerptText(
    rows.map((row) => projectMessageBody(row!.parts)).join("\n")
  )
  if (!haystack.includes(comparableExcerptText(selection.excerpt.quote))) {
    return { kind: "changed" }
  }

  const fingerprint = storableFingerprint(
    await fingerprintEntityRecords("message", referencedEntityIds(selection))
  )
  const next: EntitySelectionRef = { ...selection, capturedAt: Date.now() }
  delete next.stale
  if (fingerprint !== undefined) next.fingerprint = fingerprint
  else delete next.fingerprint
  return { kind: "current", selection: next }
}
