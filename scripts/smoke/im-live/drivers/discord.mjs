// Discord driver — a second Bot account.
//
// Discord is the one platform of the five where a bot driver is unambiguously
// fine: `lib/connectors/adapters/discord/parse.ts` drops only the target's OWN
// messages and treats other bots' traffic as legitimate inbound.
//
// The cursor is a snowflake, not a timestamp. When the channel is empty there
// is nothing to anchor to, so one is synthesised from the current clock — the
// alternative, `after=0`, would page the channel from its creation and report
// ancient messages as this run's replies.

import { cleanupMessages, requestJson } from "./http.mjs"
import { createLease, observedReply } from "./observe.mjs"

const DISCORD_EPOCH_MS = 1_420_070_400_000

/** Lowest snowflake that can have been created at `ms`. */
export function snowflakeForTime(ms) {
  return (BigInt(Math.max(0, Math.floor(ms) - DISCORD_EPOCH_MS)) << 22n).toString()
}

/** Snowflakes exceed Number.MAX_SAFE_INTEGER, so they are compared as BigInt. */
export function maxSnowflake(a, b) {
  if (!a) return b
  if (!b) return a
  return BigInt(a) >= BigInt(b) ? a : b
}

export function createDiscordDriver({ values, fetchImpl = fetch, timeoutMs, now = Date.now }) {
  const { driverBotToken, targetChannelId, targetBotUserId, apiBase } = values
  const root = apiBase.replace(/\/+$/, "")

  const call = (pathname, { method = "GET", body, expectJson = true } = {}) =>
    requestJson({
      url: `${root}${pathname}`,
      method,
      headers: { authorization: `Bot ${driverBotToken}` },
      body,
      fetchImpl,
      timeoutMs,
      expectJson,
    })

  return {
    platform: "discord",
    conversationId: String(targetChannelId),

    async doctor() {
      const checks = []
      const me = await call("/users/@me")
      checks.push({ name: "driver identity", ok: true, detail: `${me.username} (${me.id})` })

      const distinct = String(me.id) !== String(targetBotUserId)
      checks.push({
        name: "driver differs from target",
        ok: distinct,
        detail: distinct
          ? `driver ${me.id} ≠ target ${targetBotUserId}`
          : "driver and target are the same bot — a bot never sees its own messages",
      })

      try {
        const channel = await call(`/channels/${targetChannelId}`)
        checks.push({
          name: "target channel reachable",
          ok: true,
          detail: `#${channel.name ?? targetChannelId} (type ${channel.type})`,
        })
      } catch (error) {
        checks.push({
          name: "target channel reachable",
          ok: false,
          detail: `${error.message} — is the driver bot in the guild with View Channel + Send Messages?`,
        })
      }
      return checks
    },

    async prepare() {
      let cursor = snowflakeForTime(now())
      try {
        const [newest] = await call(`/channels/${targetChannelId}/messages?limit=1`)
        if (newest?.id) cursor = maxSnowflake(cursor, newest.id)
      } catch {
        // An unreadable channel is doctor's finding, not prepare's; the synthetic
        // cursor keeps this run scoped to messages posted from here on.
      }
      return createLease({
        platform: "discord",
        conversationId: String(targetChannelId),
        extra: { cursor },
      })
    },

    async injectMention(lease, marker) {
      const sent = await call(`/channels/${targetChannelId}/messages`, {
        method: "POST",
        body: { content: `<@${targetBotUserId}> ${marker}` },
      })
      lease.sentMessageIds.push(sent.id)
      return { messageId: sent.id, sentAt: Date.parse(sent.timestamp) || null }
    },

    async replyToTarget(lease, targetMessage, marker) {
      const sent = await call(`/channels/${targetChannelId}/messages`, {
        method: "POST",
        body: {
          content: marker,
          message_reference: {
            message_id: targetMessage.messageId,
            channel_id: String(targetChannelId),
            // A reference the API cannot resolve should not sink the message —
            // the harness would rather see the turn than a 400.
            fail_if_not_exists: false,
          },
        },
      })
      lease.sentMessageIds.push(sent.id)
      return { messageId: sent.id, sentAt: Date.parse(sent.timestamp) || null }
    },

    async pollTargetMessages(lease) {
      const messages = await call(
        `/channels/${targetChannelId}/messages?after=${lease.cursor}&limit=100`
      )
      const fresh = []
      // Discord pages newest-first; walk oldest-first so `observed` reads in order.
      for (const message of [...messages].reverse()) {
        lease.cursor = maxSnowflake(lease.cursor, message.id)
        if (String(message.author?.id) !== String(targetBotUserId)) continue
        fresh.push(
          observedReply({
            messageId: message.id,
            text: message.content ?? "",
            at: Date.parse(message.timestamp) || null,
            threadId: message.message_reference?.message_id ?? null,
          })
        )
      }
      return fresh
    },

    async cleanup(lease) {
      const ids = [...lease.sentMessageIds, ...lease.observed.map((m) => m.messageId)]
      return cleanupMessages(ids, (id) =>
        call(`/channels/${targetChannelId}/messages/${id}`, { method: "DELETE", expectJson: false })
      )
    },
  }
}
