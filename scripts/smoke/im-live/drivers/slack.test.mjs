import test from "node:test"
import assert from "node:assert/strict"

import { buildMarker } from "../marker.mjs"
import { createSlackDriver } from "./slack.mjs"
import { withFakePlatform } from "./fake-platform.mjs"

const CHANNEL = "C0QA123"
const TARGET = "U0BOT999"
const MARKER = buildMarker("slack", "abcd1234", 1)

const GOOD_AUTH = { ok: true, user: "qa.driver", user_id: "U0HUMAN1", team: "Cognia QA" }

function driverFor(baseUrl, overrides = {}) {
  return createSlackDriver({
    values: {
      driverUserToken: "xoxp-1111-2222-abcdefghijklmnop",
      targetChannelId: CHANNEL,
      targetBotUserId: TARGET,
      apiBase: baseUrl,
      ...overrides,
    },
    now: () => 1_700_000_000_000,
  })
}

function routes(extra = {}) {
  return {
    "POST /auth.test": () => ({ json: GOOD_AUTH }),
    "POST /conversations.info": () => ({
      json: { ok: true, channel: { name: "qa", is_member: true } },
    }),
    "POST /conversations.history": () => ({ json: { ok: true, messages: [] } }),
    "POST /conversations.replies": () => ({ json: { ok: true, messages: [] } }),
    "POST /chat.postMessage": () => ({ json: { ok: true, ts: "1700000001.000100" } }),
    "POST /chat.delete": () => ({ json: { ok: true } }),
    ...extra,
  }
}

const script = (batches) => {
  let i = 0
  return () => ({ json: { ok: true, messages: batches[i++] ?? [] } })
}

const targetMessage = (ts, text, extra = {}) => ({
  ts,
  user: TARGET,
  bot_id: "B01",
  text,
  ...extra,
})

test("doctor passes on a user token in a channel the driver has joined", async () => {
  await withFakePlatform(routes(), async ({ baseUrl }) => {
    const checks = await driverFor(baseUrl).doctor()
    assert.ok(
      checks.every((c) => c.ok),
      JSON.stringify(checks, null, 2)
    )
  })
})

test("doctor rejects a BOT token — parse.ts would drop every probe", async () => {
  await withFakePlatform(
    routes({ "POST /auth.test": () => ({ json: { ...GOOD_AUTH, bot_id: "B0DRIVER" } }) }),
    async ({ baseUrl }) => {
      const check = (await driverFor(baseUrl).doctor()).find(
        (c) => c.name === "driver token is a USER token"
      )
      assert.equal(check.ok, false)
      assert.match(check.detail, /drops every event with bot_id/)
      assert.match(check.detail, /xoxp-/)
    }
  )
})

test("doctor fails when the driver user is the target principal", async () => {
  await withFakePlatform(
    routes({ "POST /auth.test": () => ({ json: { ...GOOD_AUTH, user_id: TARGET } }) }),
    async ({ baseUrl }) => {
      const check = (await driverFor(baseUrl).doctor()).find(
        (c) => c.name === "driver differs from target"
      )
      assert.equal(check.ok, false)
    }
  )
})

test("doctor fails when the driver has not joined the channel", async () => {
  await withFakePlatform(
    routes({
      "POST /conversations.info": () => ({
        json: { ok: true, channel: { name: "qa", is_member: false } },
      }),
    }),
    async ({ baseUrl }) => {
      const check = (await driverFor(baseUrl).doctor()).find(
        (c) => c.name === "target channel reachable"
      )
      assert.equal(check.ok, false)
      assert.match(check.detail, /join it first/)
    }
  )
})

test("an ok:false envelope becomes an error naming the Slack error code", async () => {
  await withFakePlatform(
    routes({ "POST /auth.test": () => ({ json: { ok: false, error: "invalid_auth" } }) }),
    async ({ baseUrl }) => {
      await assert.rejects(driverFor(baseUrl).doctor(), /slack auth\.test failed: invalid_auth/)
    }
  )
})

test("prepare anchors `oldest` at now so an earlier run's messages are excluded", async () => {
  await withFakePlatform(routes(), async ({ baseUrl }) => {
    const lease = await driverFor(baseUrl).prepare()
    assert.equal(lease.oldest, "1700000000.000000")
  })
})

test("injectMention posts a real Slack user mention of the target bot", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, callsTo }) => {
    const driver = driverFor(baseUrl)
    const lease = await driver.prepare()
    const probe = await driver.injectMention(lease, MARKER)
    assert.equal(callsTo("POST /chat.postMessage")[0].body.text, `<@${TARGET}> ${MARKER}`)
    assert.equal(probe.messageId, "1700000001.000100")
    assert.equal(probe.sentAt, 1700000001000)
    assert.deepEqual(lease.sentMessageIds, ["1700000001.000100"])
  })
})

test("replyToTarget threads under the bot's own message", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, callsTo }) => {
    const driver = driverFor(baseUrl)
    const lease = await driver.prepare()
    await driver.replyToTarget(lease, { messageId: "1700000002.000200", threadId: null }, MARKER)
    const sent = callsTo("POST /chat.postMessage")[0].body
    assert.equal(sent.thread_ts, "1700000002.000200")
    assert.equal(sent.text, MARKER)
  })
})

test("replyToTarget stays in an existing thread rather than starting a new one", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, callsTo }) => {
    const driver = driverFor(baseUrl)
    const lease = await driver.prepare()
    await driver.replyToTarget(
      lease,
      { messageId: "1700000003.000300", threadId: "1700000001.000100" },
      MARKER
    )
    assert.equal(callsTo("POST /chat.postMessage")[0].body.thread_ts, "1700000001.000100")
  })
})

test("channel history from the target bot is normalized", async () => {
  await withFakePlatform(
    routes({
      "POST /conversations.history": script([
        [targetMessage("1700000005.000500", `echo ${MARKER}`)],
      ]),
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      const fresh = await driver.pollTargetMessages(lease)
      assert.deepEqual(fresh, [
        {
          messageId: "1700000005.000500",
          text: `echo ${MARKER}`,
          at: 1700000005000,
          threadId: null,
        },
      ])
    }
  )
})

test("an in-thread reply is found even though it never appears in history", async () => {
  await withFakePlatform(
    routes({
      "POST /conversations.replies": script([
        [
          { ts: "1700000001.000100", user: "U0HUMAN1", text: "the probe" },
          targetMessage("1700000006.000600", `threaded ${MARKER}`, {
            thread_ts: "1700000001.000100",
          }),
        ],
      ]),
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      await driver.injectMention(lease, MARKER)
      const fresh = await driver.pollTargetMessages(lease)
      assert.equal(fresh.length, 1, "the human probe must not be counted as a bot reply")
      assert.equal(fresh[0].messageId, "1700000006.000600")
      assert.equal(fresh[0].threadId, "1700000001.000100")
    }
  )
})

test("thread_not_found is normal — nothing has threaded under the probe yet", async () => {
  await withFakePlatform(
    routes({
      "POST /conversations.replies": () => ({ json: { ok: false, error: "thread_not_found" } }),
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      await driver.injectMention(lease, MARKER)
      assert.deepEqual(await driver.pollTargetMessages(lease), [])
    }
  )
})

test("a real replies error is not swallowed by the thread_not_found tolerance", async () => {
  await withFakePlatform(
    routes({
      "POST /conversations.replies": () => ({ json: { ok: false, error: "missing_scope" } }),
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      await driver.injectMention(lease, MARKER)
      await assert.rejects(driver.pollTargetMessages(lease), /missing_scope/)
    }
  )
})

test("the same message is never returned twice, even from both history and thread", async () => {
  const duplicated = targetMessage("1700000007.000700", `once ${MARKER}`, {
    thread_ts: "1700000001.000100",
  })
  await withFakePlatform(
    routes({
      "POST /conversations.history": () => ({ json: { ok: true, messages: [duplicated] } }),
      "POST /conversations.replies": () => ({ json: { ok: true, messages: [duplicated] } }),
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      await driver.injectMention(lease, MARKER)
      assert.equal((await driver.pollTargetMessages(lease)).length, 1)
      assert.equal(
        (await driver.pollTargetMessages(lease)).length,
        0,
        "a second poll returns nothing new"
      )
    }
  )
})

test("messages from humans and other bots are ignored", async () => {
  await withFakePlatform(
    routes({
      "POST /conversations.history": script([
        [
          { ts: "1700000008.000800", user: "U0HUMAN2", text: `person said ${MARKER}` },
          {
            ts: "1700000009.000900",
            user: "U0OTHERBOT",
            bot_id: "B99",
            text: `other bot ${MARKER}`,
          },
        ],
      ]),
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      assert.deepEqual(await driver.pollTargetMessages(lease), [])
    }
  )
})

test("cleanup deletes probes and observed replies by ts", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, callsTo }) => {
    const driver = driverFor(baseUrl)
    const lease = await driver.prepare()
    lease.sentMessageIds.push("1.1")
    lease.observed.push({ messageId: "2.2", text: "x" })
    const result = await driver.cleanup(lease)
    assert.deepEqual(result.deleted, ["1.1", "2.2"])
    assert.deepEqual(
      callsTo("POST /chat.delete").map((c) => c.body.ts),
      ["1.1", "2.2"]
    )
  })
})

test("cleanup reports a message it may not delete rather than failing the run", async () => {
  await withFakePlatform(
    routes({
      "POST /chat.delete": ({ body }) =>
        body.ts === "2.2"
          ? { json: { ok: false, error: "cant_delete_message" } }
          : { json: { ok: true } },
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      lease.sentMessageIds.push("1.1")
      lease.observed.push({ messageId: "2.2", text: "x" })
      const result = await driver.cleanup(lease)
      assert.deepEqual(result.deleted, ["1.1"])
      assert.match(result.retained[0].reason, /cant_delete_message/)
    }
  )
})
