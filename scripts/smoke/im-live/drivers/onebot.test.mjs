import test from "node:test"
import assert from "node:assert/strict"
import { createOneBotDriver } from "./onebot.mjs"
import { withFakePlatform } from "./fake-platform.mjs"

const values = {
  bearerToken: "test-only-token",
  targetGroupId: "987654",
  targetBotUin: "123456",
  driverUserUin: "654321",
}
const item = (id, user, text, segments = []) => ({
  message_id: id,
  user_id: user,
  time: 1700000001,
  message: [...segments, { type: "text", data: { text } }],
})
const ok = (data) => ({ json: { status: "ok", retcode: 0, data } })
function routes(history = () => []) {
  return {
    "POST /get_login_info": () => ok({ user_id: 123456 }),
    "POST /get_group_msg_history": () => ok({ messages: history() }),
  }
}
const driverFor = (baseUrl, extra = {}) =>
  createOneBotDriver({
    values: { ...values, apiBase: baseUrl },
    now: () => 1700000000000,
    ...extra,
  })

test("doctor authenticates and verifies the target account and history", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, callsTo }) => {
    assert.ok((await driverFor(baseUrl).doctor()).every((c) => c.ok))
    assert.equal(callsTo("POST /get_login_info")[0].headers.authorization, "Bearer test-only-token")
  })
})

test("doctor rejects wrong identity and business errors", async () => {
  await withFakePlatform(
    { ...routes(), "POST /get_login_info": () => ok({ user_id: 999 }) },
    async ({ baseUrl }) => {
      assert.ok((await driverFor(baseUrl).doctor()).some((c) => !c.ok))
    }
  )
  await withFakePlatform(
    {
      ...routes(),
      "POST /get_login_info": () => ({
        json: { status: "failed", retcode: 1403, message: "denied" },
      }),
    },
    async ({ baseUrl }) => {
      assert.match((await driverFor(baseUrl).doctor()).find((c) => !c.ok).detail, /denied/)
    }
  )
})

test("real human mention and quote are observed without sending API calls", async () => {
  let messages = []
  const prompts = []
  await withFakePlatform(
    routes(() => messages),
    async ({ baseUrl, calls }) => {
      const driver = driverFor(baseUrl, {
        log: (instruction) => {
          prompts.push(instruction)
          messages =
            prompts.length === 1
              ? [
                  item(1, 654321, "marker1", [{ type: "at", data: { qq: "123456" } }]),
                  item(2, 123456, "marker1"),
                ]
              : [
                  ...messages,
                  item(3, 654321, "marker2", [{ type: "reply", data: { id: "2" } }]),
                  item(4, 123456, "marker2"),
                ]
        },
      })
      const lease = await driver.prepare()
      assert.equal((await driver.injectMention(lease, "marker1")).messageId, "1")
      const replies = await driver.pollTargetMessages(lease)
      assert.equal(replies[0].messageId, "2")
      assert.equal((await driver.replyToTarget(lease, replies[0], "marker2")).messageId, "3")
      assert.equal((await driver.pollTargetMessages(lease))[0].messageId, "4")
      assert.deepEqual(await driver.pollTargetMessages(lease), [])
      assert.ok((await driver.cleanup(lease)).skipped)
      assert.ok(
        calls.every((c) => !c.pathname.includes("send_") && !c.pathname.includes("delete_"))
      )
    }
  )
})

test("plain text, wrong actor and self messages cannot satisfy a human mention", async () => {
  await withFakePlatform(
    routes(() => [
      item(1, 654321, "marker"),
      item(2, 123456, "marker", [{ type: "at", data: { qq: "123456" } }]),
    ]),
    async ({ baseUrl }) => {
      let clock = 1700000000000
      const driver = driverFor(baseUrl, {
        humanTimeoutMs: 1,
        now: () => clock++,
        sleepImpl: async () => {},
        log: () => {},
      })
      await assert.rejects(
        driver.injectMention(await driver.prepare(), "marker"),
        /human.*timed out/
      )
    }
  )
})

test("history rejects string messages rather than reporting a false pass", async () => {
  await withFakePlatform(
    routes(() => [{ message_id: 1, message: "[CQ:at,qq=123456] marker" }]),
    async ({ baseUrl }) => {
      await assert.rejects(driverFor(baseUrl).prepare(), /messagePostFormat/)
    }
  )
})

test("history walks older pages and does not silently truncate a busy group", async () => {
  let active = false
  const recent = Array.from({ length: 100 }, (_, i) => item(i + 100, 123456, "reply"))
  await withFakePlatform(
    {
      ...routes(),
      "POST /get_group_msg_history": ({ body }) =>
        ok({
          messages: !active ? [] : body.message_seq ? [item(99, 123456, "older reply")] : recent,
        }),
    },
    async ({ baseUrl, callsTo }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      active = true
      assert.equal((await driver.pollTargetMessages(lease)).length, 101)
      assert.equal(callsTo("POST /get_group_msg_history").at(-1).body.message_seq, "100")
    }
  )
})

test("repeated history pages fail without consuming replies", async () => {
  let active = false
  let fixed = false
  const recent = Array.from({ length: 100 }, (_, i) => item(i + 100, 123456, "reply"))
  await withFakePlatform(
    {
      ...routes(),
      "POST /get_group_msg_history": () =>
        ok({ messages: !active ? [] : fixed ? [recent[0]] : recent }),
    },
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      active = true
      await assert.rejects(driver.pollTargetMessages(lease), /pagination/)
      assert.equal(lease.seen.size, 0)
      fixed = true
      assert.equal((await driver.pollTargetMessages(lease)).length, 1)
    }
  )
})
