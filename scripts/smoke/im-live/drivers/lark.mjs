// Lark/Feishu driver — a second, independent test application.
//
// Lark admits bot senders: `lib/connectors/adapters/lark/parse.ts` stamps an
// app sender as `kind: "bot"` and lets it through. What it needs on the TARGET
// side is the include-bot class permission — without it the platform never
// pushes another bot's group message at all, which looks identical to a broken
// transport. `doctor` cannot read the target app's permission list, so the
// precondition is documented and the diagnostic table names it.
//
// Every write carries a `uuid` derived from the run marker. Lark treats that as
// an idempotency key, so a retry after a timeout cannot post the probe twice
// and turn one turn into a duplicate-consumption failure.

import { cleanupMessages, requestJson } from "./http.mjs"
import { createLease, observedReply } from "./observe.mjs"

/** Lark caps `uuid` at 50 characters. */
export function idempotencyKey(marker) {
  return marker.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 50)
}

/** Text lives in `body.content` as a JSON string. */
export function extractLarkText(content) {
  if (typeof content !== "string" || content === "") return ""
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    return content
  }
  if (typeof parsed?.text === "string") return parsed.text
  // Post/rich-text bodies nest arrays of runs; flatten every `text` we find so a
  // marker in a card or post body is still observable.
  const parts = []
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (node && typeof node === "object") {
      if (typeof node.text === "string") parts.push(node.text)
      Object.values(node).forEach(walk)
    }
  }
  walk(parsed)
  return parts.join(" ")
}

export function createLarkDriver({ values, fetchImpl = fetch, timeoutMs, now = Date.now }) {
  const { driverAppId, driverAppSecret, targetChatId, targetBotOpenId, targetAppId, apiBase } =
    values
  const root = apiBase.replace(/\/+$/, "")
  let token = null

  async function tenantToken() {
    if (token) return token
    const payload = await requestJson({
      url: `${root}/auth/v3/tenant_access_token/internal`,
      method: "POST",
      body: { app_id: driverAppId, app_secret: driverAppSecret },
      fetchImpl,
      timeoutMs,
    })
    if (payload?.code !== 0) {
      throw new Error(`lark tenant token failed: ${payload?.msg ?? "unknown"} (${payload?.code})`)
    }
    token = payload.tenant_access_token
    return token
  }

  async function call(
    pathname,
    { method = "GET", body, expectJson = true, envelope = false } = {}
  ) {
    const bearer = await tenantToken()
    const payload = await requestJson({
      url: `${root}${pathname}`,
      method,
      headers: { authorization: `Bearer ${bearer}` },
      body,
      fetchImpl,
      timeoutMs,
      expectJson,
    })
    // Lark answers HTTP 200 with a non-zero `code` for permission and scope
    // failures — the shape that matters most to an operator setting this up.
    if (payload && payload.code !== 0) {
      throw new Error(
        `lark ${method} ${pathname} failed: ${payload.msg ?? "unknown"} (${payload.code})`
      )
    }
    return envelope ? payload : payload?.data
  }

  const textContent = (text) => JSON.stringify({ text })
  const mention = `<at user_id="${targetBotOpenId}"></at>`

  return {
    platform: "lark",
    conversationId: String(targetChatId),

    async doctor() {
      const checks = []
      try {
        await tenantToken()
        checks.push({ name: "tenant access token", ok: true, detail: `app ${driverAppId}` })
      } catch (error) {
        checks.push({ name: "tenant access token", ok: false, detail: error.message })
        return checks
      }

      try {
        // Unlike IM APIs, bot info places `bot` at the envelope root.
        const info = await call("/bot/v3/info", { envelope: true })
        const openId = info?.bot?.open_id ?? ""
        checks.push({
          name: "driver identity",
          ok: Boolean(openId),
          detail: openId || "the bot info call returned no open_id",
        })
        const distinct =
          Boolean(openId) && openId !== String(targetBotOpenId) && driverAppId !== targetAppId
        checks.push({
          name: "driver differs from target",
          ok: distinct,
          detail: distinct
            ? `driver ${openId} ≠ target ${targetBotOpenId}`
            : "driver and target are the same app or identity is unavailable — a Lark bot's own messages never come back as events",
        })
      } catch (error) {
        checks.push({ name: "driver identity", ok: false, detail: error.message })
      }

      try {
        const chat = await call(`/im/v1/chats/${encodeURIComponent(targetChatId)}`)
        checks.push({
          name: "target chat reachable",
          ok: true,
          detail: chat?.name ?? String(targetChatId),
        })
      } catch (error) {
        checks.push({
          name: "target chat reachable",
          ok: false,
          detail: `${error.message} — is the driver app a member of chat ${targetChatId}?`,
        })
      }
      try {
        await call(
          `/im/v1/messages?${new URLSearchParams({ container_id_type: "chat", container_id: String(targetChatId), page_size: "1" })}`
        )
        checks.push({
          name: "target history readable",
          ok: true,
          detail:
            "Driver history access verified; target event subscriptions and include_bot scopes still require console verification.",
        })
      } catch (error) {
        checks.push({
          name: "target history readable",
          ok: false,
          detail: `${error.message} — check driver history permissions and im:message.group_msg.`,
        })
      }
      return checks
    },

    async prepare() {
      return createLease({
        platform: "lark",
        conversationId: String(targetChatId),
        // History is queried by a second-resolution time range.
        extra: { startTimeSec: Math.floor(now() / 1000), seen: new Set(), threadIds: new Set() },
      })
    },

    async injectMention(lease, marker) {
      const sent = await call("/im/v1/messages?receive_id_type=chat_id", {
        method: "POST",
        body: {
          receive_id: targetChatId,
          msg_type: "text",
          content: textContent(`${mention} ${marker}`),
          uuid: idempotencyKey(marker),
        },
      })
      if (sent.thread_id) lease.threadIds.add(sent.thread_id)
      lease.sentMessageIds.push(sent.message_id)
      return { messageId: sent.message_id, sentAt: Number(sent.create_time) || now() }
    },

    async replyToTarget(lease, targetMessage, marker) {
      const sent = await call(
        `/im/v1/messages/${encodeURIComponent(targetMessage.messageId)}/reply`,
        {
          method: "POST",
          body: { msg_type: "text", content: textContent(marker), uuid: idempotencyKey(marker) },
        }
      )
      if (sent.thread_id) lease.threadIds.add(sent.thread_id)
      lease.sentMessageIds.push(sent.message_id)
      return { messageId: sent.message_id, sentAt: Number(sent.create_time) || now() }
    },

    async pollTargetMessages(lease) {
      const items = []
      const readContainer = async (type, id) => {
        const query = new URLSearchParams({
          container_id_type: type,
          container_id: id,
          page_size: "50",
          sort_type: "ByCreateTimeAsc",
        })
        if (type === "chat") query.set("start_time", String(lease.startTimeSec))
        const tokens = new Set()
        for (;;) {
          const data = await call(`/im/v1/messages?${query}`)
          items.push(...(data?.items ?? []))
          for (const item of data?.items ?? []) {
            if (item.thread_id) lease.threadIds.add(item.thread_id)
          }
          if (!data?.has_more) break
          if (!data.page_token || tokens.has(data.page_token)) {
            throw new Error("lark history pagination returned a missing or repeated page_token")
          }
          tokens.add(data.page_token)
          query.set("page_token", data.page_token)
        }
      }
      await readContainer("chat", String(targetChatId))
      for (const threadId of lease.threadIds) await readContainer("thread", threadId)
      // Commit dedup only after every page succeeds, so retrying a failed
      // page cannot silently lose replies fetched before the failure.
      const fresh = []
      for (const item of items) {
        if (!item.message_id || lease.seen.has(item.message_id)) continue
        lease.seen.add(item.message_id)
        if (
          item.sender?.sender_type !== "app" ||
          item.sender?.id_type !== "app_id" ||
          item.sender.id !== targetAppId
        )
          continue
        if (Number(item.create_time) < lease.startTimeSec * 1000) continue
        fresh.push(
          observedReply({
            messageId: item.message_id,
            text: extractLarkText(item.body?.content),
            at: Number(item.create_time) || null,
            threadId: item.thread_id ?? item.parent_id ?? item.root_id ?? null,
          })
        )
      }
      return fresh
    },

    async cleanup(lease) {
      const ids = [...lease.sentMessageIds, ...lease.observed.map((m) => m.messageId)]
      return cleanupMessages(ids, (id) =>
        call(`/im/v1/messages/${encodeURIComponent(id)}`, { method: "DELETE" })
      )
    },
  }
}
