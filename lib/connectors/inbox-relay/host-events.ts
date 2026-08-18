/**
 * Host → thin-client inbound announcements (ADR-0131 cross-shell relay, §2.4).
 *
 * `lib/sync/host-invalidate.ts` tells a client "table X changed, re-pull it".
 * That is enough to keep a FOREGROUND client current, but it is deliberately
 * table-scoped, coalesced, and carries no notion of importance — so it is the
 * wrong signal to wake a backgrounded phone with.
 *
 * This module publishes the notifiable half: one `connector://message-added`
 * frame per inbound human message, carrying ids and a deep link only. Rust
 * registers a push trigger on that channel
 * (`src-tauri/src/companion_api/commands.rs`), so a phone whose WebSocket is
 * closed still gets a lock-screen notification that opens `/inbox/c?key=…`.
 *
 * Three things are deliberately NOT here:
 *
 *  - **Message text.** The frame transits APNs/FCM. The Rust body builder
 *    names the sender and the platform; the text is fetched over the
 *    authenticated sync once the app opens.
 *  - **Non-human events.** Edits, deletes, reactions, and the bot's own
 *    outbound echoes are filtered by the shared
 *    {@link isNotifiableInboundEvent} predicate — the same one the desktop
 *    Notification Center uses, so the two can never disagree about what counts
 *    as "a new message".
 *  - **Duplicate wake-ups.** A user who is actively looking at the
 *    conversation, has muted it, or is inside quiet hours already sees it (or
 *    chose not to be disturbed); publishing anyway would buzz a phone the
 *    desktop just decided to stay quiet about.
 */

import { isNotifiableInboundEvent } from "@/lib/connectors/inbound-notifiability"
import { publishHostEvent } from "@/lib/companion/host-event-publisher"
import { isViewingConversation } from "@/stores/inbox/active-conversation-store"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

export const CONNECTOR_MESSAGE_ADDED_TOPIC = "connector://message-added"

/** The id-only frame a thin client receives. */
export interface ConnectorMessageAddedPayload {
  conversationKey: string
  sessionId: string
  adapterId: string
  messageId: string
  /** Deep link the push opens — `/inbox/c?key=…`. */
  href: string
  /** Display name for the push body; omitted when the adapter resolved none. */
  senderName?: string
  /** Platform label for the push body (`telegram`, `slack`, …). */
  platform?: string
  /** Always `"connector"` — lets the client route without re-deriving. */
  source: "connector"
}

/** Injectable seams so the suppression matrix is testable without stores. */
export interface HostEventsDeps {
  publish: (topic: string, payload: ConnectorMessageAddedPayload) => void | Promise<void>
  /** The operator is looking at this conversation right now, in a focused window. */
  isViewingConversation: (conversationKey: string) => boolean
  /** The conversation is muted, or now falls inside its quiet-hours window. */
  isSilenced: (event: NormalizedInboundEvent) => Promise<boolean>
}

/**
 * Resolve mute + quiet hours with the SAME precedence the outbound runner
 * uses (`lib/connectors/outbound-runner.ts`): the per-conversation override
 * wins over the adapter default. Reusing the precedence matters — a
 * conversation the operator muted must not wake their phone just because the
 * inbound side re-derived "muted" differently from the outbound side.
 *
 * Any lookup failure resolves to "not silenced": missing a suppression is a
 * spurious notification, while a thrown error here would swallow the
 * announcement for every message.
 */
async function defaultIsSilenced(event: NormalizedInboundEvent): Promise<boolean> {
  try {
    const [{ readForResolution }, { getAdapterInstance }, { isInQuietHours }] = await Promise.all([
      import("@/lib/db/conversation-overrides"),
      import("@/lib/db/adapter-instances"),
      import("@/lib/connectors/outbound-runner"),
    ])
    const override = await readForResolution(event.conversationKey)
    if (override?.muted) return true
    const adapter = await getAdapterInstance(event.adapterId)
    if (adapter?.muted) return true
    const quietHours = override?.quietHours ?? adapter?.quietHours
    if (!quietHours) return false
    return isInQuietHours(Date.now(), quietHours.from, quietHours.to, quietHours.tz)
  } catch {
    return false
  }
}

const defaultDeps: HostEventsDeps = {
  publish: publishHostEvent,
  isViewingConversation,
  isSilenced: defaultIsSilenced,
}

let deps: HostEventsDeps = defaultDeps

/** Install the production seams (called by the connector runtime bootstrap). */
export function configureHostEvents(next: Partial<HostEventsDeps>): () => void {
  const previous = deps
  deps = { ...deps, ...next }
  return () => {
    deps = previous
  }
}

/** Test-only reset. */
export function __resetHostEventsForTests(): void {
  deps = defaultDeps
}

export function buildConnectorMessageAddedPayload(
  event: NormalizedInboundEvent,
  input: { sessionId: string; messageId: string }
): ConnectorMessageAddedPayload {
  return {
    conversationKey: event.conversationKey,
    sessionId: input.sessionId,
    adapterId: event.adapterId,
    messageId: input.messageId,
    href: `/inbox/c?key=${encodeURIComponent(event.conversationKey)}`,
    ...(event.sender?.displayName ? { senderName: event.sender.displayName } : {}),
    ...(event.platform ? { platform: event.platform } : {}),
    source: "connector",
  }
}

/**
 * Announce one inbound message to paired thin clients. Best-effort and never
 * throws — this runs right after the authoritative `messages` write, and a
 * lost notification must never roll back a persisted message.
 *
 * Returns whether a frame was actually published, so callers (and tests) can
 * distinguish "suppressed" from "published".
 */
export async function publishInboundMessageAdded(
  event: NormalizedInboundEvent,
  input: { sessionId: string; messageId: string }
): Promise<boolean> {
  try {
    if (!isNotifiableInboundEvent(event)) return false
    if (deps.isViewingConversation(event.conversationKey)) return false
    if (await deps.isSilenced(event)) return false
    await deps.publish(
      CONNECTOR_MESSAGE_ADDED_TOPIC,
      buildConnectorMessageAddedPayload(event, input)
    )
    return true
  } catch {
    // Best-effort — see module doc.
    return false
  }
}
