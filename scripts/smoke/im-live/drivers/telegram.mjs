// Telegram driver — a second, independent Bot account.
//
// Two Telegram-specific facts shape this driver, and `doctor` checks both
// because either one produces a silent "the bot never answered":
//
//   1. Privacy mode. A bot in a group sees only commands and replies aimed at
//      it unless privacy mode is off. With it ON, the driver posts its probe
//      fine but can never OBSERVE the target's answer, so every run times out
//      with the product working perfectly. `getMe` reports this as
//      `can_read_all_group_messages`.
//   2. getUpdates and webhooks are mutually exclusive. If the driver token has
//      a webhook registered, every getUpdates call fails with 409 — including
//      the ones this harness uses to watch for the reply.

import { cleanupMessages, requestJson } from "./http.mjs"
import { createLease, observedReply } from "./observe.mjs"

export function createTelegramDriver({ values, fetchImpl = fetch, timeoutMs }) {
  const { driverBotToken, targetChatId, targetBotUsername, apiBase } = values
  const call = (method, body) =>
    requestJson({
      url: `${apiBase.replace(/\/+$/, "")}/bot${driverBotToken}/${method}`,
      method: "POST",
      body: body ?? {},
      fetchImpl,
      timeoutMs,
    }).then((payload) => {
      // Telegram answers 200 with `ok:false` for most application errors, so a
      // status check alone would let them through as success.
      if (payload?.ok !== true) {
        throw new Error(
          `telegram ${method} failed: ${payload?.description ?? "unknown"} (${payload?.error_code ?? "?"})`
        )
      }
      return payload.result
    })

  const wantedUsername = String(targetBotUsername).replace(/^@/, "")

  return {
    platform: "telegram",
    conversationId: String(targetChatId),

    async doctor() {
      const checks = []
      const me = await call("getMe")
      checks.push({ name: "driver identity", ok: true, detail: `@${me.username} (id ${me.id})` })

      const distinct = String(me.username).toLowerCase() !== wantedUsername.toLowerCase()
      checks.push({
        name: "driver differs from target",
        ok: distinct,
        detail: distinct
          ? `driver @${me.username} ≠ target @${wantedUsername}`
          : `driver and target are both @${wantedUsername} — a bot cannot drive itself; ` +
            `IM_LIVE_TELEGRAM_DRIVER_BOT_TOKEN must belong to a SECOND bot`,
      })

      const canRead = me.can_read_all_group_messages === true
      checks.push({
        name: "driver privacy mode is off",
        ok: canRead,
        detail: canRead
          ? "the driver can read group messages, so it can observe the target's reply"
          : "privacy mode is ON for the driver bot: it can post the probe but will never see " +
            "the target's reply, so every run would time out. Fix with @BotFather → " +
            "/setprivacy → Disable, then remove and re-add the driver bot to the group",
      })

      const webhook = await call("getWebhookInfo")
      const pollable = !webhook?.url
      checks.push({
        name: "driver token is free for getUpdates",
        ok: pollable,
        detail: pollable
          ? "no webhook registered"
          : `a webhook is registered for the driver bot (${webhook.url}); getUpdates will answer ` +
            `409. Call deleteWebhook on the DRIVER bot, or use a token nothing else consumes`,
      })

      try {
        const chat = await call("getChat", { chat_id: targetChatId })
        checks.push({
          name: "target chat reachable",
          ok: true,
          detail: `${chat.type} ${chat.title ?? chat.id}`,
        })
      } catch (error) {
        checks.push({
          name: "target chat reachable",
          ok: false,
          detail: `${error.message} — is the driver bot a member of chat ${targetChatId}?`,
        })
      }
      return checks
    },

    async prepare() {
      // Ack everything already queued so this run only ever observes its own
      // traffic. `offset: -1` returns just the newest pending update; acking
      // past it discards the backlog without downloading it.
      let offset = 0
      const tail = await call("getUpdates", { offset: -1, timeout: 0, limit: 1 })
      if (tail.length > 0) {
        offset = tail[tail.length - 1].update_id + 1
        await call("getUpdates", { offset, timeout: 0, limit: 1 })
      }
      return createLease({
        platform: "telegram",
        conversationId: String(targetChatId),
        extra: { offset },
      })
    },

    async injectMention(lease, marker) {
      const sent = await call("sendMessage", {
        chat_id: targetChatId,
        text: `@${wantedUsername} ${marker}`,
      })
      lease.sentMessageIds.push(String(sent.message_id))
      return { messageId: String(sent.message_id), sentAt: sent.date * 1000 }
    },

    async replyToTarget(lease, targetMessage, marker) {
      const sent = await call("sendMessage", {
        chat_id: targetChatId,
        text: marker,
        reply_to_message_id: Number(targetMessage.messageId),
      })
      lease.sentMessageIds.push(String(sent.message_id))
      return { messageId: String(sent.message_id), sentAt: sent.date * 1000 }
    },

    async pollTargetMessages(lease) {
      const updates = await call("getUpdates", { offset: lease.offset, timeout: 0, limit: 100 })
      const out = []
      for (const update of updates) {
        lease.offset = Math.max(lease.offset, update.update_id + 1)
        const message = update.message ?? update.channel_post
        if (!message) continue
        if (String(message.chat?.id) !== String(targetChatId)) continue
        const from = String(message.from?.username ?? "").toLowerCase()
        if (from !== wantedUsername.toLowerCase()) continue
        out.push(
          observedReply({
            messageId: message.message_id,
            text: message.text ?? message.caption ?? "",
            at: message.date * 1000,
            threadId: message.reply_to_message ? String(message.reply_to_message.message_id) : null,
          })
        )
      }
      return out
    },

    async cleanup(lease) {
      const ids = [...lease.sentMessageIds, ...lease.observed.map((m) => m.messageId)]
      return cleanupMessages(ids, (id) =>
        call("deleteMessage", { chat_id: targetChatId, message_id: Number(id) })
      )
    },
  }
}
