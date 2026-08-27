import test from "node:test"
import assert from "node:assert/strict"

import { buildMarker } from "../marker.mjs"
import { createLarkDriver, extractLarkText, idempotencyKey } from "./lark.mjs"
import { withFakePlatform } from "./fake-platform.mjs"

const CHAT = "oc_qa1234567890"
const TARGET = "ou_target0987654321"
const MARKER = buildMarker("lark", "abcd1234", 1)

function driverFor(baseUrl, overrides = {}) {
  return createLarkDriver({
    values: {
      driverAppId: "cli_driver001",
      driverAppSecret: "driver-secret-value-0001",
      targetChatId: CHAT,
      targetBotOpenId: TARGET,
      apiBase: baseUrl,
      ...overrides,
    },
    now: () => 1_700_000_000_000,
  })
}

function routes(extra = {}) {
  return {
    "POST /auth/v3/tenant_access_token/internal": () => ({
      json: { code: 0, tenant_access_token: "t-driver-token-abcdefghijkl", expire: 7200 },
    }),
    "GET /bot/v3/info": () => ({
      json: { code: 0, data: { bot: { open_id: "ou_driver1122334455", app_name: "QA Driver" } } },
    }),
    [`GET /im/v1/chats/${CHAT}`]: () => ({ json: { code: 0, data: { name: "QA Group" } } }),
    "GET /im/v1/messages": () => ({ json: { code: 0, data: { items: [] } } }),
    "POST /im/v1/messages": () => ({
      json: { code: 0, data: { message_id: "om_probe0001", create_time: "1700000001000" } },
    }),
    "POST /im/v1/messages/:messageId/reply": () => ({
      json: { code: 0, data: { message_id: "om_probe0002", create_time: "1700000002000" } },
    }),
    "DELETE /im/v1/messages/:messageId": () => ({ json: { code: 0 } }),
    ...extra,
  }
}

const targetItem = (id, text, extra = {}) => ({
  message_id: id,
  sender: { id: TARGET, id_type: "open_id", sender_type: "app" },
  body: { content: JSON.stringify({ text }) },
  create_time: "1700000005000",
  ...extra,
})

test("idempotencyKey is Lark-safe and within the 50-character cap", () => {
  const key = idempotencyKey(buildMarker("lark", "0123456789abcdef", 12))
  assert.ok(key.length <= 50, key)
  assert.match(key, /^[A-Za-z0-9-]+$/)
  assert.equal(idempotencyKey(MARKER), "cognia-e2e-lark-abcd1234-turn-1")
})

test("extractLarkText reads a plain text body", () => {
  assert.equal(extractLarkText(JSON.stringify({ text: `hello ${MARKER}` })), `hello ${MARKER}`)
})

test("extractLarkText flattens a rich post body so a marker in a card is still seen", () => {
  const post = JSON.stringify({
    zh_cn: {
      title: "t",
      content: [
        [
          { tag: "text", text: "prefix " },
          { tag: "text", text: MARKER },
        ],
      ],
    },
  })
  assert.ok(extractLarkText(post).includes(MARKER))
})

test("extractLarkText tolerates a non-JSON or empty body", () => {
  assert.equal(extractLarkText("not json"), "not json")
  assert.equal(extractLarkText(""), "")
  assert.equal(extractLarkText(undefined), "")
})

test("doctor passes for a distinct driver app in a reachable chat", async () => {
  await withFakePlatform(routes(), async ({ baseUrl }) => {
    const checks = await driverFor(baseUrl).doctor()
    assert.ok(
      checks.every((c) => c.ok),
      JSON.stringify(checks, null, 2)
    )
  })
})

test("doctor stops at the token when credentials are wrong, instead of cascading", async () => {
  await withFakePlatform(
    routes({
      "POST /auth/v3/tenant_access_token/internal": () => ({
        json: { code: 10003, msg: "invalid app_secret" },
      }),
    }),
    async ({ baseUrl }) => {
      const checks = await driverFor(baseUrl).doctor()
      assert.equal(checks.length, 1)
      assert.equal(checks[0].ok, false)
      assert.match(checks[0].detail, /invalid app_secret/)
    }
  )
})

test("doctor fails when the driver app IS the target app", async () => {
  await withFakePlatform(
    routes({
      "GET /bot/v3/info": () => ({ json: { code: 0, data: { bot: { open_id: TARGET } } } }),
    }),
    async ({ baseUrl }) => {
      const check = (await driverFor(baseUrl).doctor()).find(
        (c) => c.name === "driver differs from target"
      )
      assert.equal(check.ok, false)
      assert.match(check.detail, /own messages never come back/)
    }
  )
})

test("a non-zero code on HTTP 200 is an error naming the Lark code", async () => {
  await withFakePlatform(
    routes({
      [`GET /im/v1/chats/${CHAT}`]: () => ({ json: { code: 99991672, msg: "no permission" } }),
    }),
    async ({ baseUrl }) => {
      const check = (await driverFor(baseUrl).doctor()).find(
        (c) => c.name === "target chat reachable"
      )
      assert.equal(check.ok, false)
      assert.match(check.detail, /no permission \(99991672\)/)
      assert.match(check.detail, /member of chat/)
    }
  )
})

test("the tenant token is fetched once and reused", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, callsTo }) => {
    const driver = driverFor(baseUrl)
    await driver.doctor()
    await driver.prepare()
    assert.equal(callsTo("POST /auth/v3/tenant_access_token/internal").length, 1)
  })
})

test("injectMention sends an <at> mention with an idempotency uuid", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, callsTo }) => {
    const driver = driverFor(baseUrl)
    const lease = await driver.prepare()
    const probe = await driver.injectMention(lease, MARKER)
    const call = callsTo("POST /im/v1/messages")[0]
    assert.equal(call.query.receive_id_type, "chat_id")
    assert.equal(call.body.receive_id, CHAT)
    assert.equal(call.body.msg_type, "text")
    assert.equal(JSON.parse(call.body.content).text, `<at user_id="${TARGET}"></at> ${MARKER}`)
    assert.equal(call.body.uuid, idempotencyKey(MARKER))
    assert.equal(probe.messageId, "om_probe0001")
    assert.equal(probe.sentAt, 1700000001000)
  })
})

test("replyToTarget uses the dedicated reply endpoint", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, callsTo }) => {
    const driver = driverFor(baseUrl)
    const lease = await driver.prepare()
    await driver.replyToTarget(lease, { messageId: "om_bot0001" }, MARKER)
    const call = callsTo("POST /im/v1/messages/om_bot0001/reply")[0]
    assert.ok(call, "the reply endpoint must be used, not a fresh send")
    assert.equal(JSON.parse(call.body.content).text, MARKER)
  })
})

test("history is queried forward from the run's start time", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, callsTo }) => {
    const driver = driverFor(baseUrl)
    const lease = await driver.prepare()
    await driver.pollTargetMessages(lease)
    const query = callsTo("GET /im/v1/messages")[0].query
    assert.equal(query.container_id, CHAT)
    assert.equal(query.container_id_type, "chat")
    assert.equal(query.sort_type, "ByCreateTimeAsc")
    assert.equal(query.start_time, "1700000000")
  })
})

test("the target app's messages are normalized, others are skipped", async () => {
  await withFakePlatform(
    routes({
      "GET /im/v1/messages": () => ({
        json: {
          code: 0,
          data: {
            items: [
              {
                message_id: "om_human",
                sender: { id: "ou_person", sender_type: "user" },
                body: { content: JSON.stringify({ text: "hi" }) },
                create_time: "1700000004000",
              },
              targetItem("om_reply1", `echo ${MARKER}`, { parent_id: "om_probe0001" }),
            ],
          },
        },
      }),
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      const fresh = await driver.pollTargetMessages(lease)
      assert.deepEqual(fresh, [
        {
          messageId: "om_reply1",
          text: `echo ${MARKER}`,
          at: 1700000005000,
          threadId: "om_probe0001",
        },
      ])
    }
  )
})

test("a message already returned is not returned again", async () => {
  await withFakePlatform(
    routes({
      "GET /im/v1/messages": () => ({
        json: { code: 0, data: { items: [targetItem("om_x", MARKER)] } },
      }),
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      assert.equal((await driver.pollTargetMessages(lease)).length, 1)
      assert.equal((await driver.pollTargetMessages(lease)).length, 0)
    }
  )
})

test("cleanup deletes probes and replies, and reports a refusal", async () => {
  await withFakePlatform(
    routes({
      "DELETE /im/v1/messages/:messageId": ({ params }) =>
        params.messageId === "om_reply1"
          ? { json: { code: 230002, msg: "no permission to delete" } }
          : { json: { code: 0 } },
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      lease.sentMessageIds.push("om_probe0001")
      lease.observed.push({ messageId: "om_reply1", text: "x" })
      const result = await driver.cleanup(lease)
      assert.deepEqual(result.deleted, ["om_probe0001"])
      assert.equal(result.ok, false)
      assert.match(result.retained[0].reason, /no permission to delete/)
    }
  )
})
