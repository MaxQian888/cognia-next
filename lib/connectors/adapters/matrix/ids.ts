/**
 * Matrix message-id and conversation-key helpers.
 *
 * Matrix room-scoped operations (redact / react / edit) need BOTH the room id
 * and the event id, but the {@link PlatformAdapter} message-op contract only
 * carries a single `messageId` string. Room ids contain colons
 * (`!abc:server.org`), so the composite uses `|` as the separator:
 * `"<roomId>|<eventId>"`. Mirrors the `channelId:messageId` convention the
 * Discord adapter uses (Discord ids are colon-free, Matrix ids are not).
 *
 * The composite is the adapter's public id currency: `send()`/`edit()` return
 * it as `platformMessageId`, the inbound parser stamps it on
 * `NormalizedInboundEvent.messageId` / `replacesMessageId`, and every
 * message-scoped op (`delete` / `addReaction` / `removeReaction` / `edit`)
 * accepts it — so ids round-trip through the bus stored-message index
 * (`metadata.platformMessage.messageId`) in both directions.
 *
 * NOTE: `|` never appears in Matrix identifiers — room ids are
 * `!localpart:server[:port]` and event ids are `$base64url` (v3+) or
 * `$localpart:server` (legacy) — so splitting on the FIRST `|` is unambiguous.
 */

export const MATRIX_MESSAGE_ID_SEP = "|"

/** Compose the adapter-public `"<roomId>|<eventId>"` message id. */
export function buildMatrixMessageId(roomId: string, eventId: string): string {
  return `${roomId}${MATRIX_MESSAGE_ID_SEP}${eventId}`
}

/**
 * Split a `"<roomId>|<eventId>"` composite. Throws a descriptive error on a
 * malformed id so callers (bus / workflow nodes) surface a clear failure
 * instead of hitting the homeserver with a truncated room id.
 */
export function splitMatrixMessageId(composite: string): { roomId: string; eventId: string } {
  const sep = composite.indexOf(MATRIX_MESSAGE_ID_SEP)
  if (sep <= 0 || sep === composite.length - 1) {
    throw new Error(
      `Matrix message id must be "<roomId>|<eventId>" (got "${composite}"); ` +
        `use the platformMessageId returned by send()/edit() or the inbound event messageId`
    )
  }
  return { roomId: composite.slice(0, sep), eventId: composite.slice(sep + 1) }
}

/**
 * Strip the `"<roomId>|"` prefix from a composite id, passing bare event ids
 * through unchanged. Used where the WIRE needs a bare event id (`m.relates_to`
 * targets) but callers may hold the adapter-public composite.
 */
export function bareMatrixEventId(id: string): string {
  const sep = id.indexOf(MATRIX_MESSAGE_ID_SEP)
  return sep >= 0 ? id.slice(sep + 1) : id
}

export interface ParsedMatrixConversationKey {
  adapterId: string
  roomId: string
  threadId?: string
}

/**
 * Decompose a Matrix conversation key built by
 * `buildConversationKey("matrix", adapterId, roomId, threadId?)` —
 * i.e. `"matrix:<adapterId>:<roomId>[:<threadRootEventId>]"`.
 *
 * Room ids contain colons (`!abc:server.org`, optionally `:port`), so a naive
 * `split(":")[2]` truncates the room. Instead: everything after
 * `matrix:<adapterId>:` is the room id, minus a trailing `:$...` thread
 * segment — thread roots are event ids, which ALWAYS start with `$`, while no
 * room-id segment (server name or port) can. Legacy v1/v2 event ids
 * (`$localpart:server`) as thread roots are not supported by this heuristic;
 * every homeserver still in service issues v3+ (`$base64url`) ids.
 *
 * NOTE (reported upstream, not fixed here): the generic
 * `parseConversationKey` in `types/connectors/event.ts` has the same
 * colon-splitting bug for Matrix keys; this adapter-side helper is the
 * workaround until the central fix lands.
 */
export function parseMatrixConversationKey(key: string): ParsedMatrixConversationKey {
  const parts = key.split(":")
  if (parts.length < 3 || parts[0] !== "matrix") {
    throw new Error(`invalid matrix conversationKey: ${key}`)
  }
  const adapterId = parts[1]
  const rest = parts.slice(2)
  const last = rest[rest.length - 1]
  if (rest.length > 1 && last.startsWith("$")) {
    return { adapterId, roomId: rest.slice(0, -1).join(":"), threadId: last }
  }
  return { adapterId, roomId: rest.join(":") }
}
