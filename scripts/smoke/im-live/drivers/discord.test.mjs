import test from "node:test"
import assert from "node:assert/strict"

import { buildMarker } from "../marker.mjs"
import { createDiscordDriver, maxSnowflake, snowflakeForTime } from "./discord.mjs"
import { withFakePlatform } from "./fake-platform.mjs"

const CHANNEL = "1100000000000000001"
const TARGET = "1200000000000000002"
const MARKER = buildMarker("discord", "abcd1234", 1)
const NOW = 1_700_000_000_000

function driverFor(baseUrl, overrides = {}) {
  return createDiscordDriver({
    values: {
      driverBotToken: "MTIz.AbCdEf.ghijklmnopqrstuvwxyz0123456",
      targetChannelId: CHANNEL,
      targetBotUserId: TARGET,
      apiBase: baseUrl,
      ...overrides,
    },
    now: () => NOW,
  })
}

function routes(extra = {}) {
  return {
    "GET /users/@me": () => ({ json: { id: "1300000000000000003", username: "qa-driver" } }),
    [`GET /channels/${CHANNEL}`]: () => ({ json: { id: CHANNEL, name: "qa", type: 0 } }),
    [`GET /channels/${CHANNEL}/messages`]: () => ({ json: [] }),
    [`POST /channels/${CHANNEL}/messages`]: () => ({
      json: { id: "1400000000000000004", timestamp: "2026-08-27T10:00:00.000000+00:00" },
    }),
    ...extra,
  }
}

const targetMessage = (id, content, extra = {}) => ({
  id,
  content,
  author: { id: TARGET, bot: true },
  timestamp: "2026-08-27T10:00:05.000000+00:00",
  ...extra,
})

test("snowflakeForTime produces a comparable id anchored at the Discord epoch", () => {
  assert.equal(snowflakeForTime(1_420_070_400_000), "0")
  assert.equal(snowflakeForTime(1_420_070_401_000), String(1000n << 22n))
  assert.equal(snowflakeForTime(0), "0", "pre-epoch clamps rather than going negative")
})

test("maxSnowflake compares beyond Number.MAX_SAFE_INTEGER", () => {
  const low = "1400000000000000004"
  const high = "1400000000000000005"
  assert.equal(maxSnowflake(low, high), high)
  assert.equal(maxSnowflake(high, low), high)
  assert.equal(maxSnowflake(null, low), low)
  assert.equal(maxSnowflake(low, null), low)
})

test("doctor passes on a distinct bot in a reachable channel", async () => {
  await withFakePlatform(routes(), async ({ baseUrl }) => {
    const checks = await driverFor(baseUrl).doctor()
    assert.ok(
      checks.every((c) => c.ok),
      JSON.stringify(checks, null, 2)
    )
    assert.match(checks[0].detail, /qa-driver/)
  })
})

test("doctor fails when the driver bot IS the target bot", async () => {
  await withFakePlatform(
    routes({ "GET /users/@me": () => ({ json: { id: TARGET, username: "target" } }) }),
    async ({ baseUrl }) => {
      const check = (await driverFor(baseUrl).doctor()).find(
        (c) => c.name === "driver differs from target"
      )
      assert.equal(check.ok, false)
      assert.match(check.detail, /never sees its own messages/)
    }
  )
})

test("doctor points at the guild permissions when the channel is unreadable", async () => {
  await withFakePlatform(
    routes({
      [`GET /channels/${CHANNEL}`]: () => ({
        status: 403,
        json: { code: 50001, message: "Missing Access" },
      }),
    }),
    async ({ baseUrl }) => {
      const check = (await driverFor(baseUrl).doctor()).find(
        (c) => c.name === "target channel reachable"
      )
      assert.equal(check.ok, false)
      assert.match(check.detail, /Missing Access/)
      assert.match(check.detail, /View Channel \+ Send Messages/)
    }
  )
})

test("prepare anchors on the newest existing message", async () => {
  await withFakePlatform(
    routes({
      [`GET /channels/${CHANNEL}/messages`]: () => ({ json: [{ id: "1500000000000000005" }] }),
    }),
    async ({ baseUrl }) => {
      const lease = await driverFor(baseUrl).prepare()
      assert.equal(lease.cursor, "1500000000000000005")
    }
  )
})

test("an empty channel falls back to a clock-derived cursor, never `after=0`", async () => {
  await withFakePlatform(routes(), async ({ baseUrl }) => {
    const lease = await driverFor(baseUrl).prepare()
    assert.equal(lease.cursor, snowflakeForTime(NOW))
    assert.notEqual(lease.cursor, "0")
  })
})

test("an unreadable channel still yields a scoped cursor instead of throwing", async () => {
  await withFakePlatform(
    routes({
      [`GET /channels/${CHANNEL}/messages`]: () => ({ status: 403, json: { message: "no" } }),
    }),
    async ({ baseUrl }) => {
      const lease = await driverFor(baseUrl).prepare()
      assert.equal(lease.cursor, snowflakeForTime(NOW))
    }
  )
})

test("injectMention posts a real Discord user mention", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, callsTo }) => {
    const driver = driverFor(baseUrl)
    const lease = await driver.prepare()
    const probe = await driver.injectMention(lease, MARKER)
    assert.equal(
      callsTo(`POST /channels/${CHANNEL}/messages`)[0].body.content,
      `<@${TARGET}> ${MARKER}`
    )
    assert.equal(probe.messageId, "1400000000000000004")
    assert.equal(probe.sentAt, Date.parse("2026-08-27T10:00:00.000Z"))
    assert.deepEqual(lease.sentMessageIds, ["1400000000000000004"])
  })
})

test("replyToTarget references the bot's message and tolerates an unresolvable one", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, callsTo }) => {
    const driver = driverFor(baseUrl)
    const lease = await driver.prepare()
    await driver.replyToTarget(lease, { messageId: "1600000000000000006" }, MARKER)
    const sent = callsTo(`POST /channels/${CHANNEL}/messages`)[0].body
    assert.deepEqual(sent.message_reference, {
      message_id: "1600000000000000006",
      channel_id: CHANNEL,
      fail_if_not_exists: false,
    })
    assert.equal(sent.content, MARKER)
  })
})

test("pollTargetMessages normalizes the target's messages and advances the cursor", async () => {
  await withFakePlatform(
    routes({
      [`GET /channels/${CHANNEL}/messages`]: ({ query }) =>
        query.after
          ? {
              json: [
                targetMessage("1700000000000000009", `echo ${MARKER}`, {
                  message_reference: { message_id: "1400000000000000004" },
                }),
              ],
            }
          : { json: [] },
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      const fresh = await driver.pollTargetMessages(lease)
      assert.deepEqual(fresh, [
        {
          messageId: "1700000000000000009",
          text: `echo ${MARKER}`,
          at: Date.parse("2026-08-27T10:00:05.000Z"),
          threadId: "1400000000000000004",
        },
      ])
      assert.equal(lease.cursor, "1700000000000000009")
    }
  )
})

test("a page is walked oldest-first even though Discord returns it newest-first", async () => {
  await withFakePlatform(
    routes({
      [`GET /channels/${CHANNEL}/messages`]: ({ query }) =>
        query.after
          ? {
              json: [
                targetMessage("1700000000000000020", "second"),
                targetMessage("1700000000000000010", "first"),
              ],
            }
          : { json: [] },
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      const fresh = await driver.pollTargetMessages(lease)
      assert.deepEqual(
        fresh.map((m) => m.text),
        ["first", "second"]
      )
      assert.equal(lease.cursor, "1700000000000000020")
    }
  )
})

test("the cursor advances past skipped authors so they are not re-fetched forever", async () => {
  await withFakePlatform(
    routes({
      [`GET /channels/${CHANNEL}/messages`]: ({ query }) =>
        query.after
          ? {
              json: [
                {
                  id: "1700000000000000030",
                  content: "hi",
                  author: { id: "1900000000000000009" },
                  timestamp: "2026-08-27T10:00:06.000000+00:00",
                },
              ],
            }
          : { json: [] },
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      assert.deepEqual(await driver.pollTargetMessages(lease), [])
      assert.equal(lease.cursor, "1700000000000000030")
    }
  )
})

test("cleanup deletes with an empty 204 body and reports refusals", async () => {
  await withFakePlatform(
    routes({
      [`DELETE /channels/${CHANNEL}/messages/:id`]: ({ params }) =>
        params.id === "2"
          ? { status: 403, json: { message: "Missing Permissions" } }
          : { status: 204 },
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      lease.sentMessageIds.push("1")
      lease.observed.push({ messageId: "2", text: "x" })
      const result = await driver.cleanup(lease)
      assert.deepEqual(result.deleted, ["1"])
      assert.equal(result.ok, false)
      assert.match(result.retained[0].reason, /Missing Permissions/)
    }
  )
})
