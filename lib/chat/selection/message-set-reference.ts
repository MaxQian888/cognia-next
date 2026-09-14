/**
 * Several whole messages of one conversation, staged as ONE reference.
 *
 * What the transcript's selection mode hands the composer. One chip rather than
 * one per message, because the thing a person ticked is one piece of context
 * ("these four turns are the discussion"), and twelve chips for twelve ticks
 * would bury the draft. It stays a `message` entity reference with `members`,
 * so everything a message reference already has keeps working per message:
 * each member is cited on send and earns its own backlink
 * (`selection-citations.ts`), the reference goes stale when any member is edited
 * (`fingerprintEntityRecords`), and the prompt heading counts them
 * (`format-selection-context.ts`).
 *
 * The body is each message exactly as `@msg:` reads one — tool output included,
 * a sent context envelope noted — numbered and linked, in the order given. That
 * order is the transcript's: the caller passes the ids as the list shows them,
 * which is the only order that accounts for edited and regenerated turns.
 * Each message is clamped on its own, so a long one cannot crowd the rest out.
 */

import type { EntityReferenceMember, EntitySelectionRef } from "@/types/artifact/artifact"
import {
  clampEntitySnapshot,
  entitySnapshotBody,
  fingerprintEntityRecords,
  referencedEntityIds,
  wrapEntitySnapshot,
} from "@/lib/chat/mentions/entity-sources"
import {
  formatMessageReference,
  messageRefId,
  parseMessageRefId,
  projectMessageBody,
} from "@/lib/chat/mentions/message-reference"
import {
  loadSessionMessages,
  messageExcerptHref,
  messageMemberTitle,
  storableFingerprint,
} from "./message-excerpt"

export interface MessageSetInput {
  sessionId: string
  /** The messages, in transcript order. Repeats are dropped, first one kept. */
  messageIds: readonly string[]
  /** Defaults to now. Injectable so a test can pin it. */
  capturedAt?: number
}

/**
 * The reference for the messages that can still be read, or null when none can.
 *
 * A message that is gone, belongs to another conversation or projects to nothing
 * (an image with no description) is left out rather than failing the rest. One
 * readable message is an ordinary message reference, identical to picking it
 * with `@msg:`, so staging it twice by the two routes refreshes one chip.
 */
export async function buildMessageSetReference(
  input: MessageSetInput
): Promise<EntitySelectionRef | null> {
  const requested = [...new Set(input.messageIds)]
  if (requested.length === 0) return null
  const rows = await loadSessionMessages(input.sessionId, requested)
  const kept = requested.flatMap((id, index) => {
    const row = rows[index]
    const body = row ? projectMessageBody(row.parts) : ""
    return row && body ? [{ id, row, body }] : []
  })
  if (kept.length === 0) return null

  const refIds = kept.map(({ id }) => messageRefId(input.sessionId, id))
  const fingerprint = storableFingerprint(
    await fingerprintEntityRecords("message", refIds).catch(() => undefined)
  )
  const first = kept[0]!
  const base = {
    kind: "entity" as const,
    entityKind: "message" as const,
    entityId: refIds[0]!,
    comment: "",
    capturedAt: input.capturedAt ?? Date.now(),
    href: messageExcerptHref(input.sessionId, first.id),
    sourceSessionId: input.sessionId,
    ...(fingerprint !== undefined ? { fingerprint } : {}),
  }

  if (kept.length === 1) {
    return {
      ...base,
      title: messageMemberTitle(first.row, first.id),
      snapshot: entitySnapshotBody(
        "message",
        formatMessageReference([{ role: first.row.role, parts: first.row.parts }], 0) ?? first.body
      ),
    }
  }

  const members: EntityReferenceMember[] = kept.map(({ id, row }, index) => ({
    entityId: refIds[index]!,
    title: messageMemberTitle(row, id),
    href: messageExcerptHref(input.sessionId, id),
  }))
  // Numbered and linked per message: the heading only says how many there are,
  // and a model asked about "the third one" has to be able to find it.
  const body = kept
    .map(
      ({ row, body: text }, index) =>
        `${index + 1}. ${row.role} — ${members[index]!.href}\n${clampEntitySnapshot(text)}`
    )
    .join("\n\n")
  return {
    ...base,
    title: members[0]!.title,
    snapshot: wrapEntitySnapshot("message", body),
    members,
  }
}

/** A staged reference to several whole messages (not a selection inside them). */
export function isMessageSetReference(selection: {
  kind: string
  entityKind?: string
  excerpt?: unknown
  members?: readonly unknown[]
}): boolean {
  return (
    selection.kind === "entity" &&
    selection.entityKind === "message" &&
    !selection.excerpt &&
    (selection.members?.length ?? 0) > 1
  )
}

/**
 * Read a combined reference again from its messages, optionally without one.
 *
 * The refresh for a combined chip and the removal of one of its messages are the
 * same operation: the body is rebuilt from what is stored now, never patched, so
 * a member edited in the meantime cannot survive in the old wording beside the
 * rest in the new. The user's comment on the chip is kept. Null when nothing is
 * left to reference.
 */
export async function rebuildMessageSetReference(
  selection: Pick<EntitySelectionRef, "entityId" | "members" | "comment">,
  { without }: { without?: string } = {}
): Promise<EntitySelectionRef | null> {
  const refs = referencedEntityIds(selection)
    .filter((id) => id !== without)
    .map(parseMessageRefId)
  const sessionId = refs.find((ref) => ref !== null)?.sessionId
  if (!sessionId) return null
  const messageIds = refs.flatMap((ref) =>
    ref && ref.sessionId === sessionId ? [ref.messageId] : []
  )
  const next = await buildMessageSetReference({ sessionId, messageIds })
  return next ? { ...next, comment: selection.comment } : null
}
