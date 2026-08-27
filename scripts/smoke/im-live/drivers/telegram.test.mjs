import test from "node:test"
import assert from "node:assert/strict"

import { buildMarker } from "../marker.mjs"
import { createTelegramDriver } from "./telegram.mjs"
import { withFakePlatform } from "./fake-platform.mjs"

const TOKEN = "8123456789:AAH1zQxYbCdEfGhIjKlMnOpQrStUvWxYz01"
const CHAT = "-1001234567890"
const MARKER = buildMarker("telegram", "abcd1234", 1)

const ok = (result) => ({ json: { ok: true, result } })
const GOOD_ME = {
  id: 111,
  is_bot: true,
  username: "cognia_driver_bot",
  can_read_all_group_messages: true,
}

function driverFor(baseUrl, overrides = {}) {
  return createTelegramDriver({
    values: {
      driverBotToken: TOKEN,
      targetChatId: CHAT,
      targetBotUsername: "cognia_target_bot",
      apiBase: baseUrl,
      ...overrides,
    },
  })
}

/** Routes for a healthy sandbox, overridable per test. */
function routes(extra = {}) {
  return {
    [`POST /bot${TOKEN}/getMe`]: () => ok(GOOD_ME),
    [`POST /bot${TOKEN}/getWebhookInfo`]: () => ok({ url: "" }),
    [`POST /bot${TOKEN}/getChat`]: () => ok({ id: Number(CHAT), type: "supergroup", title: "QA" }),
    [`POST /bot${TOKEN}/getUpdates`]: () => ok([]),
    [`POST /bot${TOKEN}/sendMessage`]: ({ body }) =>
      ok({ message_id: 900, date: 1700, chat: { id: Number(CHAT) }, text: body.text }),
    [`POST /bot${TOKEN}/deleteMessage`]: () => ok(true),
    ...extra,
  }
}

/** One `getUpdates` script: successive calls return successive batches. */
function updatesScript(batches) {
  let index = 0
  return () => ok(batches[index++] ?? [])
}

function targetUpdate(updateId, messageId, text, extra = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1701,
      chat: { id: Number(CHAT) },
      from: { id: 222, is_bot: true, username: "cognia_target_bot" },
      text,
      ...extra,
    },
  }
}

test("doctor passes on a healthy sandbox and names the driver identity", async () => {
  await withFakePlatform(routes(), async ({ baseUrl }) => {
    const checks = await driverFor(baseUrl).doctor()
    assert.ok(
      checks.every((c) => c.ok),
      JSON.stringify(checks, null, 2)
    )
    assert.match(checks[0].detail, /@cognia_driver_bot/)
  })
})

test("doctor fails when the driver bot IS the target bot", async () => {
  await withFakePlatform(
    routes({
      [`POST /bot${TOKEN}/getMe`]: () => ok({ ...GOOD_ME, username: "cognia_target_bot" }),
    }),
    async ({ baseUrl }) => {
      const checks = await driverFor(baseUrl).doctor()
      const check = checks.find((c) => c.name === "driver differs from target")
      assert.equal(check.ok, false)
      assert.match(check.detail, /SECOND bot/)
    }
  )
})

test("doctor fails on privacy mode — the run would otherwise time out mysteriously", async () => {
  await withFakePlatform(
    routes({
      [`POST /bot${TOKEN}/getMe`]: () => ok({ ...GOOD_ME, can_read_all_group_messages: false }),
    }),
    async ({ baseUrl }) => {
      const check = (await driverFor(baseUrl).doctor()).find(
        (c) => c.name === "driver privacy mode is off"
      )
      assert.equal(check.ok, false)
      assert.match(check.detail, /\/setprivacy/)
    }
  )
})

test("doctor fails when a webhook owns the driver token", async () => {
  await withFakePlatform(
    routes({
      [`POST /bot${TOKEN}/getWebhookInfo`]: () => ok({ url: "https://example.test/hook" }),
    }),
    async ({ baseUrl }) => {
      const check = (await driverFor(baseUrl).doctor()).find(
        (c) => c.name === "driver token is free for getUpdates"
      )
      assert.equal(check.ok, false)
      assert.match(check.detail, /409/)
    }
  )
})

test("doctor reports an unreachable chat instead of throwing", async () => {
  await withFakePlatform(
    routes({
      [`POST /bot${TOKEN}/getChat`]: () => ({
        json: { ok: false, error_code: 400, description: "chat not found" },
      }),
    }),
    async ({ baseUrl }) => {
      const check = (await driverFor(baseUrl).doctor()).find(
        (c) => c.name === "target chat reachable"
      )
      assert.equal(check.ok, false)
      assert.match(check.detail, /chat not found/)
      assert.match(check.detail, /member of chat/)
    }
  )
})

test("an ok:false envelope is an error even though the status is 200", async () => {
  await withFakePlatform(
    routes({
      [`POST /bot${TOKEN}/getMe`]: () => ({
        json: { ok: false, error_code: 401, description: "Unauthorized" },
      }),
    }),
    async ({ baseUrl }) => {
      await assert.rejects(
        driverFor(baseUrl).doctor(),
        /telegram getMe failed: Unauthorized \(401\)/
      )
    }
  )
})

test("prepare acks the backlog so a run only observes its own traffic", async () => {
  await withFakePlatform(
    routes({
      [`POST /bot${TOKEN}/getUpdates`]: updatesScript([[targetUpdate(500, 1, "stale")], []]),
    }),
    async ({ baseUrl, callsTo }) => {
      const lease = await driverFor(baseUrl).prepare()
      assert.equal(lease.offset, 501)
      const acks = callsTo(`POST /bot${TOKEN}/getUpdates`)
      assert.equal(acks[0].body.offset, -1, "first call peeks the newest pending update")
      assert.equal(acks[1].body.offset, 501, "second call acks past it")
    }
  )
})

test("prepare on an empty queue starts at offset 0", async () => {
  await withFakePlatform(routes(), async ({ baseUrl }) => {
    assert.equal((await driverFor(baseUrl).prepare()).offset, 0)
  })
})

test("injectMention @-mentions the target and records the id for cleanup", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, callsTo }) => {
    const driver = driverFor(baseUrl)
    const lease = await driver.prepare()
    const probe = await driver.injectMention(lease, MARKER)
    const sent = callsTo(`POST /bot${TOKEN}/sendMessage`)[0].body
    assert.equal(sent.text, `@cognia_target_bot ${MARKER}`)
    assert.equal(sent.chat_id, CHAT)
    assert.equal(probe.messageId, "900")
    assert.equal(probe.sentAt, 1700 * 1000)
    assert.deepEqual(lease.sentMessageIds, ["900"])
  })
})

test("a leading @ in the configured username is not doubled", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, callsTo }) => {
    const driver = driverFor(baseUrl, { targetBotUsername: "@cognia_target_bot" })
    const lease = await driver.prepare()
    await driver.injectMention(lease, MARKER)
    assert.equal(
      callsTo(`POST /bot${TOKEN}/sendMessage`)[0].body.text,
      `@cognia_target_bot ${MARKER}`
    )
  })
})

test("replyToTarget threads onto the bot's own message — the reply-to-bot admission path", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, callsTo }) => {
    const driver = driverFor(baseUrl)
    const lease = await driver.prepare()
    await driver.replyToTarget(lease, { messageId: "42" }, MARKER)
    const sent = callsTo(`POST /bot${TOKEN}/sendMessage`)[0].body
    assert.equal(sent.reply_to_message_id, 42)
    assert.equal(sent.text, MARKER)
  })
})

test("pollTargetMessages normalizes the target's messages and advances the offset", async () => {
  await withFakePlatform(
    routes({
      [`POST /bot${TOKEN}/getUpdates`]: updatesScript([
        [],
        [targetUpdate(700, 12, `echo ${MARKER}`, { reply_to_message: { message_id: 900 } })],
      ]),
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      const fresh = await driver.pollTargetMessages(lease)
      assert.equal(fresh.length, 1)
      assert.deepEqual(fresh[0], {
        messageId: "12",
        text: `echo ${MARKER}`,
        at: 1701 * 1000,
        threadId: "900",
      })
      assert.equal(lease.offset, 701)
    }
  )
})

test("pollTargetMessages ignores other chats, humans and other bots", async () => {
  const foreign = {
    update_id: 800,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: -999 },
      from: { username: "cognia_target_bot" },
      text: "elsewhere",
    },
  }
  const human = {
    update_id: 801,
    message: {
      message_id: 2,
      date: 1,
      chat: { id: Number(CHAT) },
      from: { username: "a_person" },
      text: "hi",
    },
  }
  const otherBot = {
    update_id: 802,
    message: {
      message_id: 3,
      date: 1,
      chat: { id: Number(CHAT) },
      from: { username: "unrelated_bot" },
      text: "hi",
    },
  }
  await withFakePlatform(
    routes({ [`POST /bot${TOKEN}/getUpdates`]: updatesScript([[], [foreign, human, otherBot]]) }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      assert.deepEqual(await driver.pollTargetMessages(lease), [])
      assert.equal(lease.offset, 803, "the offset still advances past what we skipped")
    }
  )
})

test("a caption-only reply is still observed", async () => {
  const captioned = {
    update_id: 900,
    message: {
      message_id: 5,
      date: 2,
      chat: { id: Number(CHAT) },
      from: { username: "cognia_target_bot" },
      caption: `image says ${MARKER}`,
    },
  }
  await withFakePlatform(
    routes({ [`POST /bot${TOKEN}/getUpdates`]: updatesScript([[], [captioned]]) }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      assert.equal((await driver.pollTargetMessages(lease))[0].text, `image says ${MARKER}`)
    }
  )
})

test("cleanup deletes the probes and the observed replies", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, callsTo }) => {
    const driver = driverFor(baseUrl)
    const lease = await driver.prepare()
    lease.sentMessageIds.push("900", "901")
    lease.observed.push({ messageId: "12", text: "x" })
    const result = await driver.cleanup(lease)
    assert.deepEqual(result.deleted, ["900", "901", "12"])
    assert.equal(result.ok, true)
    assert.deepEqual(
      callsTo(`POST /bot${TOKEN}/deleteMessage`).map((c) => c.body.message_id),
      [900, 901, 12]
    )
  })
})

test("cleanup keeps going when one delete is refused, and says which", async () => {
  await withFakePlatform(
    routes({
      [`POST /bot${TOKEN}/deleteMessage`]: ({ body }) =>
        body.message_id === 12
          ? { json: { ok: false, error_code: 400, description: "message can't be deleted" } }
          : ok(true),
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      lease.sentMessageIds.push("900")
      lease.observed.push({ messageId: "12", text: "x" })
      const result = await driver.cleanup(lease)
      assert.deepEqual(result.deleted, ["900"])
      assert.equal(result.ok, false)
      assert.equal(result.retained[0].id, "12")
      assert.match(result.retained[0].reason, /can't be deleted/)
    }
  )
})
