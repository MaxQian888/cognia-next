// Personal QQ needs a different human account to trigger Cognia. This driver
// only reads NapCat's HTTP API; Cognia still receives/sends over its configured
// forward or reverse WebSocket. Reuse the shared two-turn fixture/report flow.
import { pollUntil, requestJson, sleep } from "./http.mjs"
import { createLease, observedReply } from "./observe.mjs"

const PAGE_SIZE = 100
const textOf = (message) =>
  message.message
    .filter((s) => s.type === "text")
    .map((s) => s.data?.text ?? "")
    .join("")

export function createOneBotDriver({
  values,
  fetchImpl = fetch,
  timeoutMs = 30000,
  humanTimeoutMs = 120000,
  now = Date.now,
  sleepImpl = sleep,
  log = console.log,
}) {
  const { apiBase, bearerToken, targetGroupId, targetBotUin, driverUserUin } = values
  const root = new URL(apiBase)
  // The extra observer API is local to the Mac. Never put bearer credentials
  // in URLs (which are included in HTTP diagnostics).
  if (
    !["http:", "https:"].includes(root.protocol) ||
    root.username ||
    root.password ||
    root.search ||
    root.hash
  )
    throw new Error("OneBot API base must be an HTTP URL without credentials, query or fragment")
  const base = root.href.replace(/\/+$/, "")
  const call = async (action, params = {}) => {
    const payload = await requestJson({
      url: `${base}/${action}`,
      method: "POST",
      body: params,
      headers: { authorization: `Bearer ${bearerToken}` },
      fetchImpl,
      timeoutMs,
    })
    if (payload?.status !== "ok" || payload.retcode !== 0)
      throw new Error(
        `onebot ${action} failed: ${payload?.message ?? payload?.wording ?? "unknown"} (${payload?.retcode})`
      )
    return payload.data
  }
  const page = async (cursor) => {
    const data = await call("get_group_msg_history", {
      group_id: String(targetGroupId),
      count: PAGE_SIZE,
      ...(cursor ? { message_seq: cursor } : {}),
    })
    if (!Array.isArray(data?.messages)) throw new Error("OneBot history returned no messages array")
    for (const item of data.messages) {
      if (!Array.isArray(item.message))
        throw new Error("Set NapCat HTTP messagePostFormat to array")
      if (item.message_id === undefined || !Number.isFinite(Number(item.time)))
        throw new Error("OneBot history returned a message without id/time")
    }
    return data.messages
  }
  const history = async (lease) => {
    const all = new Map()
    const cursors = new Set()
    let cursor
    const deadline = now() + timeoutMs
    for (;;) {
      const messages = await page(cursor)
      for (const item of messages) all.set(String(item.message_id), item)
      const oldest = messages.reduce(
        (a, b) => (!a || Number(b.time) < Number(a.time) ? b : a),
        null
      )
      if (
        messages.length < PAGE_SIZE ||
        messages.some((m) => lease.baseline.has(String(m.message_id))) ||
        Number(oldest?.time) < lease.startTimeSec
      )
        break
      // NapCat resolves message_seq through its short message-id map.
      cursor = String(oldest.message_id)
      if (cursors.has(cursor) || now() >= deadline)
        throw new Error(
          "OneBot history pagination did not reach the run boundary; retry in a quiet test group"
        )
      cursors.add(cursor)
    }
    return [...all.values()]
      .filter(
        (m) => !lease.baseline.has(String(m.message_id)) && Number(m.time) >= lease.startTimeSec
      )
      .sort((a, b) => Number(a.time) - Number(b.time))
  }
  const waitHuman = async (lease, marker, replyId) => {
    log(
      replyId
        ? `[im-live] onebot: as QQ ${driverUserUin}, quote reply ${replyId} in group ${targetGroupId} with: ${marker}`
        : `[im-live] onebot: as QQ ${driverUserUin}, select @${targetBotUin} from QQ's mention picker in group ${targetGroupId} and send: ${marker}`
    )
    const found = await pollUntil(
      async () => {
        const messages = await history(lease)
        return (
          messages.find(
            (m) =>
              String(m.user_id ?? m.sender?.user_id) === String(driverUserUin) &&
              textOf(m).includes(marker) &&
              m.message.some((s) =>
                replyId
                  ? s.type === "reply" && String(s.data?.id) === String(replyId)
                  : s.type === "at" && String(s.data?.qq) === String(targetBotUin)
              )
          ) ?? null
        )
      },
      { timeoutMs: humanTimeoutMs, now, sleepImpl }
    )
    if (!found)
      throw new Error(
        "OneBot human mention/quote timed out; no matching message from the configured driver user"
      )
    return { messageId: String(found.message_id), sentAt: Number(found.time) * 1000 }
  }
  return {
    platform: "onebot",
    conversationId: String(targetGroupId),
    async doctor() {
      const checks = [
        {
          name: "human differs from target",
          ok: driverUserUin !== targetBotUin,
          detail: "Use a second QQ account for mentions and quoted replies.",
        },
      ]
      try {
        const info = await call("get_login_info")
        checks.push({
          name: "target identity",
          ok: String(info?.user_id) === String(targetBotUin),
          detail: `NapCat account ${info?.user_id}, expected ${targetBotUin}`,
        })
      } catch (error) {
        checks.push({ name: "target identity", ok: false, detail: error.message })
      }
      try {
        await page()
        checks.push({
          name: "group history readable",
          ok: true,
          detail:
            "HTTP observer ready; the live turns verify Cognia's WebSocket delivery separately.",
        })
      } catch (error) {
        checks.push({ name: "group history readable", ok: false, detail: error.message })
      }
      return checks
    },
    async prepare() {
      const startTimeSec = Math.floor(now() / 1000)
      const existing = await page()
      return createLease({
        platform: "onebot",
        conversationId: String(targetGroupId),
        extra: {
          startTimeSec,
          baseline: new Set(existing.map((m) => String(m.message_id))),
          seen: new Set(),
        },
      })
    },
    injectMention: (lease, marker) => waitHuman(lease, marker),
    replyToTarget: (lease, target, marker) => waitHuman(lease, marker, target.messageId),
    async pollTargetMessages(lease) {
      const fresh = []
      for (const item of await history(lease)) {
        const id = String(item.message_id)
        if (lease.seen.has(id)) continue
        lease.seen.add(id)
        if (String(item.user_id ?? item.sender?.user_id) !== String(targetBotUin)) continue
        fresh.push(
          observedReply({
            messageId: id,
            text: textOf(item),
            at: Number(item.time) * 1000,
            threadId: item.message.find((s) => s.type === "reply")?.data?.id ?? null,
          })
        )
      }
      return fresh
    },
    async cleanup() {
      return {
        skipped: true,
        ok: true,
        reason: "Human-driven QQ test: retained messages for manual inspection and cleanup.",
      }
    },
  }
}
