// Slack driver — a test USER identity, not a second bot.
//
// `lib/connectors/adapters/slack/parse.ts` drops every event carrying `bot_id`,
// unconditionally and before any other check. A second Slack app therefore
// cannot reach the target no matter how it is configured, so this driver
// requires a user OAuth token and `doctor` refuses a bot token outright rather
// than letting the run fail 120 seconds later as an unexplained timeout.
//
// Replies are collected from BOTH the channel history and the thread under each
// probe: a target configured to answer in-thread posts a message that never
// appears in `conversations.history`, and watching only one of the two would
// report a working bot as silent.

import { cleanupMessages, requestJson } from "./http.mjs"
import { createLease, observedReply } from "./observe.mjs"

export function createSlackDriver({ values, fetchImpl = fetch, timeoutMs, now = Date.now }) {
  const { driverUserToken, targetChannelId, targetBotUserId, apiBase } = values
  const root = apiBase.replace(/\/+$/, "")

  const call = (method, body) =>
    requestJson({
      url: `${root}/${method}`,
      method: "POST",
      headers: { authorization: `Bearer ${driverUserToken}` },
      body: body ?? {},
      fetchImpl,
      timeoutMs,
    }).then((payload) => {
      // Slack answers 200 with `ok:false` for scope and permission errors.
      if (payload?.ok !== true)
        throw new Error(`slack ${method} failed: ${payload?.error ?? "unknown"}`)
      return payload
    })

  const isTarget = (message) =>
    String(message?.user ?? "") === String(targetBotUserId) ||
    String(message?.bot_id ?? "") === String(targetBotUserId)

  return {
    platform: "slack",
    conversationId: String(targetChannelId),

    async doctor() {
      const checks = []
      const auth = await call("auth.test")
      checks.push({
        name: "driver identity",
        ok: true,
        detail: `${auth.user} (${auth.user_id}) on ${auth.team}`,
      })

      // `auth.test` reports `bot_id` for bot tokens. A user token has none.
      const isUserToken = !auth.bot_id
      checks.push({
        name: "driver token is a USER token",
        ok: isUserToken,
        detail: isUserToken
          ? "user identity — its messages carry no bot_id and will reach the target"
          : "IM_LIVE_SLACK_DRIVER_USER_TOKEN is a BOT token (auth.test returned bot_id). " +
            "lib/connectors/adapters/slack/parse.ts drops every event with bot_id, so the target " +
            "would never see the probe. Install the driver app with a user scope and use its " +
            "xoxp- token",
      })

      const distinct = String(auth.user_id) !== String(targetBotUserId)
      checks.push({
        name: "driver differs from target",
        ok: distinct,
        detail: distinct
          ? `driver ${auth.user_id} ≠ target ${targetBotUserId}`
          : "the driver user and the target bot are the same principal",
      })

      try {
        const info = await call("conversations.info", { channel: targetChannelId })
        const member = info.channel?.is_member !== false
        checks.push({
          name: "target channel reachable",
          ok: member,
          detail: member
            ? `#${info.channel?.name ?? targetChannelId}`
            : `the driver is not a member of #${info.channel?.name ?? targetChannelId} — join it first`,
        })
      } catch (error) {
        checks.push({ name: "target channel reachable", ok: false, detail: error.message })
      }
      return checks
    },

    async prepare() {
      // Slack timestamps are seconds-with-microseconds strings; anything at or
      // before this instant belongs to an earlier run.
      return createLease({
        platform: "slack",
        conversationId: String(targetChannelId),
        extra: { oldest: (now() / 1000).toFixed(6), seen: new Set() },
      })
    },

    async injectMention(lease, marker) {
      const sent = await call("chat.postMessage", {
        channel: targetChannelId,
        text: `<@${targetBotUserId}> ${marker}`,
      })
      lease.sentMessageIds.push(sent.ts)
      return { messageId: sent.ts, sentAt: Math.floor(Number(sent.ts) * 1000) }
    },

    async replyToTarget(lease, targetMessage, marker) {
      const sent = await call("chat.postMessage", {
        channel: targetChannelId,
        // Thread onto the bot's own message: that is the `reply-to-bot`
        // admission path, and it keeps the second turn in one thread.
        thread_ts: targetMessage.threadId ?? targetMessage.messageId,
        text: marker,
      })
      lease.sentMessageIds.push(sent.ts)
      return { messageId: sent.ts, sentAt: Math.floor(Number(sent.ts) * 1000) }
    },

    async pollTargetMessages(lease) {
      const candidates = []
      const history = await call("conversations.history", {
        channel: targetChannelId,
        oldest: lease.oldest,
        inclusive: false,
        limit: 100,
      })
      candidates.push(...(history.messages ?? []))

      // Thread replies never appear in history — page each probe's thread too.
      for (const ts of lease.sentMessageIds) {
        try {
          const thread = await call("conversations.replies", {
            channel: targetChannelId,
            ts,
            limit: 100,
          })
          candidates.push(...(thread.messages ?? []))
        } catch (error) {
          // `thread_not_found` just means nothing threaded under that probe yet.
          if (!/thread_not_found/.test(error.message)) throw error
        }
      }

      const fresh = []
      for (const message of candidates) {
        if (!isTarget(message)) continue
        if (lease.seen.has(message.ts)) continue
        lease.seen.add(message.ts)
        fresh.push(
          observedReply({
            messageId: message.ts,
            text: message.text ?? "",
            at: Math.floor(Number(message.ts) * 1000),
            threadId: message.thread_ts ?? null,
          })
        )
      }
      return fresh
    },

    async cleanup(lease) {
      const ids = [...lease.sentMessageIds, ...lease.observed.map((m) => m.messageId)]
      return cleanupMessages(ids, (ts) => call("chat.delete", { channel: targetChannelId, ts }))
    },
  }
}
