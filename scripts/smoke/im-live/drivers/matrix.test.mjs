import test from "node:test"
import assert from "node:assert/strict"

import { buildMarker } from "../marker.mjs"
import { createMatrixDriver } from "./matrix.mjs"
import { withFakePlatform } from "./fake-platform.mjs"

const ROOM = "!qaroom:example.test"
const TARGET = "@cognia_target:example.test"
const MARKER = buildMarker("matrix", "abcd1234", 1)
const NOW = 1_700_000_000_000
const ROOM_PATH = encodeURIComponent(ROOM)

function driverFor(baseUrl, overrides = {}) {
  return createMatrixDriver({
    values: {
      homeserver: baseUrl,
      driverAccessToken: "syt_ZHJpdmVy_AbCdEfGhIjKlMn_0a1b2c",
      targetRoomId: ROOM,
      targetUserId: TARGET,
      ...overrides,
    },
    now: () => NOW,
  })
}

const V3 = "/_matrix/client/v3"

function routes(extra = {}) {
  return {
    [`GET ${V3}/account/whoami`]: () => ({
      json: { user_id: "@qa_driver:example.test", device_id: "D1" },
    }),
    [`GET ${V3}/joined_rooms`]: () => ({ json: { joined_rooms: [ROOM] } }),
    [`GET ${V3}/rooms/${ROOM_PATH}/state/m.room.encryption`]: () => ({
      status: 404,
      json: { errcode: "M_NOT_FOUND", error: "Event not found." },
    }),
    [`GET ${V3}/rooms/${ROOM_PATH}/messages`]: () => ({ json: { chunk: [] } }),
    [`PUT ${V3}/rooms/${ROOM_PATH}/send/m.room.message/:txn`]: () => ({
      json: { event_id: "$probe1" },
    }),
    [`PUT ${V3}/rooms/${ROOM_PATH}/redact/:eventId/:txn`]: () => ({
      json: { event_id: "$redact1" },
    }),
    ...extra,
  }
}

const targetEvent = (eventId, body, extra = {}) => ({
  type: "m.room.message",
  event_id: eventId,
  sender: TARGET,
  origin_server_ts: NOW + 5000,
  content: { msgtype: "m.text", body, ...(extra.content ?? {}) },
  ...extra,
})

test("doctor passes for a distinct joined user in an unencrypted room", async () => {
  await withFakePlatform(routes(), async ({ baseUrl }) => {
    const checks = await driverFor(baseUrl).doctor()
    assert.ok(
      checks.every((c) => c.ok),
      JSON.stringify(checks, null, 2)
    )
  })
})

test("doctor fails when the driver account IS the target", async () => {
  await withFakePlatform(
    routes({ [`GET ${V3}/account/whoami`]: () => ({ json: { user_id: TARGET } }) }),
    async ({ baseUrl }) => {
      const check = (await driverFor(baseUrl).doctor()).find(
        (c) => c.name === "driver differs from target"
      )
      assert.equal(check.ok, false)
      assert.match(check.detail, /drops its own events/)
    }
  )
})

test("doctor fails when the driver has not joined the room", async () => {
  await withFakePlatform(
    routes({ [`GET ${V3}/joined_rooms`]: () => ({ json: { joined_rooms: [] } }) }),
    async ({ baseUrl }) => {
      const check = (await driverFor(baseUrl).doctor()).find(
        (c) => c.name === "driver has joined the room"
      )
      assert.equal(check.ok, false)
      assert.match(check.detail, /accept the invite/)
    }
  )
})

test("an encrypted room is rejected up front, not discovered as a timeout", async () => {
  await withFakePlatform(
    routes({
      [`GET ${V3}/rooms/${ROOM_PATH}/state/m.room.encryption`]: () => ({
        json: { algorithm: "m.megolm.v1.aes-sha2" },
      }),
    }),
    async ({ baseUrl }) => {
      const check = (await driverFor(baseUrl).doctor()).find(
        (c) => c.name === "room is unencrypted"
      )
      assert.equal(check.ok, false)
      assert.match(check.detail, /use an unencrypted room/)
    }
  )
})

test("a 404 on the encryption state event means unencrypted, and is not an error", async () => {
  await withFakePlatform(routes(), async ({ baseUrl }) => {
    const check = (await driverFor(baseUrl).doctor()).find((c) => c.name === "room is unencrypted")
    assert.equal(check.ok, true)
  })
})

test("a non-404 failure on the encryption probe is surfaced, not read as unencrypted", async () => {
  await withFakePlatform(
    routes({
      [`GET ${V3}/rooms/${ROOM_PATH}/state/m.room.encryption`]: () => ({
        status: 403,
        json: { errcode: "M_FORBIDDEN", error: "not in room" },
      }),
    }),
    async ({ baseUrl }) => {
      await assert.rejects(driverFor(baseUrl).doctor(), /HTTP 403/)
    }
  )
})

test("injectMention carries the spec's intentional-mention signal", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, calls }) => {
    const driver = driverFor(baseUrl)
    const lease = await driver.prepare()
    const probe = await driver.injectMention(lease, MARKER)
    const send = calls.find((c) => c.method === "PUT" && c.pathname.includes("/send/"))
    assert.deepEqual(send.body["m.mentions"], { user_ids: [TARGET] })
    assert.ok(send.body.body.includes(MARKER))
    assert.equal(send.body.msgtype, "m.text")
    assert.equal(probe.messageId, "$probe1")
    assert.deepEqual(lease.sentMessageIds, ["$probe1"])
  })
})

test("each send uses a fresh transaction id — a repeat would be a silent no-op", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, calls }) => {
    const driver = driverFor(baseUrl)
    const lease = await driver.prepare()
    await driver.injectMention(lease, MARKER)
    await driver.injectMention(lease, MARKER)
    const txns = calls
      .filter((c) => c.pathname.includes("/send/"))
      .map((c) => c.pathname.split("/").pop())
    assert.equal(new Set(txns).size, 2, "two sends must not share a transaction id")
  })
})

test("replyToTarget builds an m.in_reply_to relation", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, calls }) => {
    const driver = driverFor(baseUrl)
    const lease = await driver.prepare()
    await driver.replyToTarget(lease, { messageId: "$botEvent" }, MARKER)
    const send = calls.find((c) => c.method === "PUT" && c.pathname.includes("/send/"))
    assert.deepEqual(send.body["m.relates_to"], { "m.in_reply_to": { event_id: "$botEvent" } })
  })
})

test("pollTargetMessages normalizes the target's events, oldest first", async () => {
  await withFakePlatform(
    routes({
      [`GET ${V3}/rooms/${ROOM_PATH}/messages`]: () => ({
        json: {
          chunk: [
            targetEvent("$second", "second", { origin_server_ts: NOW + 7000 }),
            targetEvent("$first", `echo ${MARKER}`, {
              content: { "m.relates_to": { "m.in_reply_to": { event_id: "$probe1" } } },
            }),
          ],
        },
      }),
    }),
    async ({ baseUrl, callsTo }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      const fresh = await driver.pollTargetMessages(lease)
      assert.deepEqual(
        fresh.map((m) => m.messageId),
        ["$first", "$second"]
      )
      assert.equal(fresh[0].threadId, "$probe1")
      assert.equal(callsTo(`GET ${V3}/rooms/${ROOM_PATH}/messages`)[0].query.dir, "b")
    }
  )
})

test("events from before the run started are ignored", async () => {
  await withFakePlatform(
    routes({
      [`GET ${V3}/rooms/${ROOM_PATH}/messages`]: () => ({
        json: { chunk: [targetEvent("$old", `stale ${MARKER}`, { origin_server_ts: NOW - 1 })] },
      }),
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      assert.deepEqual(await driver.pollTargetMessages(lease), [])
    }
  )
})

test("other senders and non-message events are skipped", async () => {
  await withFakePlatform(
    routes({
      [`GET ${V3}/rooms/${ROOM_PATH}/messages`]: () => ({
        json: {
          chunk: [
            {
              type: "m.room.member",
              event_id: "$m",
              sender: TARGET,
              origin_server_ts: NOW + 1,
              content: {},
            },
            targetEvent("$other", `hi ${MARKER}`, { sender: "@someone:example.test" }),
          ],
        },
      }),
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      assert.deepEqual(await driver.pollTargetMessages(lease), [])
    }
  )
})

test("an event already returned is not returned again", async () => {
  await withFakePlatform(
    routes({
      [`GET ${V3}/rooms/${ROOM_PATH}/messages`]: () => ({
        json: { chunk: [targetEvent("$one", MARKER)] },
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

test("cleanup redacts probes and replies, and reports a refusal", async () => {
  await withFakePlatform(
    routes({
      [`PUT ${V3}/rooms/${ROOM_PATH}/redact/:eventId/:txn`]: ({ params }) =>
        params.eventId === "$reply"
          ? { status: 403, json: { errcode: "M_FORBIDDEN", error: "cannot redact" } }
          : { json: { event_id: "$r" } },
    }),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl)
      const lease = await driver.prepare()
      lease.sentMessageIds.push("$probe1")
      lease.observed.push({ messageId: "$reply", text: "x" })
      const result = await driver.cleanup(lease)
      assert.deepEqual(result.deleted, ["$probe1"])
      assert.equal(result.ok, false)
      assert.match(result.retained[0].reason, /cannot redact/)
    }
  )
})
