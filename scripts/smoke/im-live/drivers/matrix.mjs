// Matrix driver — an ordinary second user on the same homeserver.
//
// Matrix has no bot concept, so the driver is a normal account and the target
// adapter's only filter is "not me" (`adapters/matrix/parse.ts`). That makes it
// the least constrained of the five platforms, with one exception `doctor`
// checks explicitly: the adapter's E2EE path is out of scope for this harness,
// so an ENCRYPTED room would leave the target unable to read the probe. That
// failure is indistinguishable from a dead transport at the platform level, so
// it is caught up front.

import { randomUUID } from "node:crypto"

import { DriverHttpError, cleanupMessages, requestJson } from "./http.mjs"
import { createLease, observedReply } from "./observe.mjs"

export function createMatrixDriver({ values, fetchImpl = fetch, timeoutMs, now = Date.now }) {
  const { homeserver, driverAccessToken, targetRoomId, targetUserId } = values
  const root = `${homeserver.replace(/\/+$/, "")}/_matrix/client/v3`
  const room = encodeURIComponent(targetRoomId)

  const call = (pathname, { method = "GET", body } = {}) =>
    requestJson({
      url: `${root}${pathname}`,
      method,
      headers: { authorization: `Bearer ${driverAccessToken}` },
      body,
      fetchImpl,
      timeoutMs,
    })

  /** Matrix requires a unique transaction id per send; a repeat is a no-op resend. */
  const txn = () => `cognia-im-live-${randomUUID()}`

  return {
    platform: "matrix",
    conversationId: String(targetRoomId),

    async doctor() {
      const checks = []
      const who = await call("/account/whoami")
      checks.push({ name: "driver identity", ok: true, detail: who.user_id })

      const distinct = String(who.user_id) !== String(targetUserId)
      checks.push({
        name: "driver differs from target",
        ok: distinct,
        detail: distinct
          ? `driver ${who.user_id} ≠ target ${targetUserId}`
          : "driver and target are the same account — the adapter drops its own events",
      })

      const joined = await call("/joined_rooms")
      const inRoom = (joined.joined_rooms ?? []).includes(targetRoomId)
      checks.push({
        name: "driver has joined the room",
        ok: inRoom,
        detail: inRoom
          ? targetRoomId
          : `${targetRoomId} is not in the driver's joined rooms — accept the invite first`,
      })

      // 404 on the encryption state event is the healthy answer: the room is
      // unencrypted. A 200 means the state event exists and the room is E2EE.
      let encrypted = false
      try {
        await call(`/rooms/${room}/state/m.room.encryption`)
        encrypted = true
      } catch (error) {
        if (!(error instanceof DriverHttpError) || error.status !== 404) throw error
      }
      checks.push({
        name: "room is unencrypted",
        ok: !encrypted,
        detail: encrypted
          ? "the room has m.room.encryption set. This harness sends plaintext events, which an " +
            "E2EE room's members cannot read — use an unencrypted room for live testing"
          : "no m.room.encryption state event",
      })
      return checks
    },

    async prepare() {
      return createLease({
        platform: "matrix",
        conversationId: String(targetRoomId),
        // Backward pagination plus a timestamp floor: simpler and more robust
        // than threading a /sync token, and it cannot skip an event.
        extra: { sinceTs: now(), seen: new Set() },
      })
    },

    async injectMention(lease, marker) {
      const sent = await call(`/rooms/${room}/send/m.room.message/${txn()}`, {
        method: "PUT",
        body: {
          msgtype: "m.text",
          body: `${targetUserId}: ${marker}`,
          // The spec's intentional-mention signal — the adapter reads this first.
          "m.mentions": { user_ids: [targetUserId] },
        },
      })
      lease.sentMessageIds.push(sent.event_id)
      return { messageId: sent.event_id, sentAt: now() }
    },

    async replyToTarget(lease, targetMessage, marker) {
      const sent = await call(`/rooms/${room}/send/m.room.message/${txn()}`, {
        method: "PUT",
        body: {
          msgtype: "m.text",
          body: marker,
          "m.mentions": { user_ids: [targetUserId] },
          "m.relates_to": { "m.in_reply_to": { event_id: targetMessage.messageId } },
        },
      })
      lease.sentMessageIds.push(sent.event_id)
      return { messageId: sent.event_id, sentAt: now() }
    },

    async pollTargetMessages(lease) {
      const query = new URLSearchParams({ dir: "b", limit: "50" })
      const page = await call(`/rooms/${room}/messages?${query}`)
      const fresh = []
      // Backward pagination yields newest-first; reverse so `observed` is ordered.
      for (const event of [...(page.chunk ?? [])].reverse()) {
        if (event.type !== "m.room.message") continue
        if (lease.seen.has(event.event_id)) continue
        if (Number(event.origin_server_ts) < lease.sinceTs) continue
        lease.seen.add(event.event_id)
        if (String(event.sender) !== String(targetUserId)) continue
        fresh.push(
          observedReply({
            messageId: event.event_id,
            text: event.content?.body ?? "",
            at: Number(event.origin_server_ts) || null,
            threadId: event.content?.["m.relates_to"]?.["m.in_reply_to"]?.event_id ?? null,
          })
        )
      }
      return fresh
    },

    async cleanup(lease) {
      const ids = [...lease.sentMessageIds, ...lease.observed.map((m) => m.messageId)]
      return cleanupMessages(ids, (eventId) =>
        call(`/rooms/${room}/redact/${encodeURIComponent(eventId)}/${txn()}`, {
          method: "PUT",
          body: { reason: "cognia im-live harness cleanup" },
        })
      )
    },
  }
}
