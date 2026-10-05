/** The op log through the Worker and the space (protocol §6–7). */
import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"

import {
  Person,
  fakeEnvelopes,
  sealedOps,
  spaceWithGenesis,
  testEnv,
  twoDevices,
} from "../test/helpers"
import { purgeSpaceOf } from "./admin"
import { handleRequest } from "./index"
import { OPLOG_READONLY_BYTES } from "./ops"
import { REVOKED_CLOSE_CODE, type SyncSpace } from "./space"

async function openSocket(
  spaceId: string,
  ticket: string
): Promise<{ socket: WebSocket; messages: unknown[] }> {
  const response = await handleRequest(
    new Request(`https://sync.test/v1/socket?space=${spaceId}&ticket=${ticket}`, {
      headers: { upgrade: "websocket" },
    }),
    testEnv
  )
  expect(response.status).toBe(101)
  const socket = response.webSocket!
  const messages: unknown[] = []
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data as string))
  })
  socket.accept()
  return { socket, messages }
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("the op log", () => {
  it("stores pushes in order and serves them as batches", async () => {
    const { space, second } = await twoDevices()
    const spaceId = await space.person.spaceId()
    const fromFirst = await sealedOps(spaceId, space.first, { from: 1, count: 2 })
    const pushed = await space.person.json("POST", "/v1/ops", {
      body: { ops: fromFirst },
      device: space.first,
    })
    expect(pushed).toEqual({ status: 200, body: { deviceSeq: 2, firstSeq: 1, lastSeq: 2 } })
    const fromSecond = await sealedOps(spaceId, second.device, { from: 1, count: 1 })
    expect(
      (
        await space.person.json("POST", "/v1/ops", {
          body: { ops: fromSecond },
          device: second.device,
        })
      ).body
    ).toEqual({ deviceSeq: 1, firstSeq: 3, lastSeq: 3 })

    const all = await space.person.json("GET", "/v1/ops?after=0", { device: second.device })
    expect(all.status).toBe(200)
    expect(all.body.lastSeq).toBe(3)
    expect(all.body.more).toBe(false)
    expect(all.body.registryHead.seq).toBe(1)
    expect(all.body.batches).toEqual([
      { firstSeq: 1, lastSeq: 2, deviceId: space.first.deviceId, ops: fromFirst },
      { firstSeq: 3, lastSeq: 3, deviceId: second.device.deviceId, ops: fromSecond },
    ])
    const after = await space.person.json("GET", "/v1/ops?after=2", { device: space.first })
    expect(after.body.batches.map((batch: { firstSeq: number }) => batch.firstSeq)).toEqual([3])
  })

  it("acknowledges a resent push without storing it twice, and reports a gap", async () => {
    const space = await spaceWithGenesis()
    const spaceId = await space.person.spaceId()
    const ops = await sealedOps(spaceId, space.first, { from: 1, count: 2 })
    await space.person.json("POST", "/v1/ops", { body: { ops }, device: space.first })
    expect(
      (await space.person.json("POST", "/v1/ops", { body: { ops }, device: space.first })).body
    ).toEqual({ deviceSeq: 2, firstSeq: null, lastSeq: null })
    const gap = await sealedOps(spaceId, space.first, { from: 4, count: 1 })
    expect(
      await space.person.json("POST", "/v1/ops", { body: { ops: gap }, device: space.first })
    ).toEqual({
      status: 409,
      body: { error: "seq_gap", expected: 3, message: "ops are missing before this push" },
    })
    const log = await space.person.json("GET", "/v1/ops", { device: space.first })
    expect(log.body.lastSeq).toBe(2)
  })

  it("needs a device proof, an existing space and an active device", async () => {
    const space = await spaceWithGenesis()
    const spaceId = await space.person.spaceId()
    const ops = await sealedOps(spaceId, space.first, { from: 1, count: 1 })
    expect((await space.person.json("POST", "/v1/ops", { body: { ops } })).status).toBe(401)
    expect((await space.person.json("GET", "/v1/ops")).status).toBe(401)
    const nobody = new Person()
    expect((await nobody.json("GET", "/v1/ops", { device: space.first })).body.error).toBe(
      "space_empty"
    )
  })

  it("refuses ops from a removed device, and closes its socket", async () => {
    const { space, second } = await twoDevices()
    const spaceId = await space.person.spaceId()
    const ticket = await space.person.json("POST", "/v1/socket/ticket", { device: second.device })
    const { socket } = await openSocket(spaceId, ticket.body.ticket)
    let closedWith = 0
    socket.addEventListener("close", (event) => {
      closedWith = event.code
    })
    const revoke = await space.chain.revoke(space.first, second.device.deviceId)
    await space.person.json("POST", "/v1/registry", {
      body: { entries: [revoke], envelopes: fakeEnvelopes(space.chain.state) },
      device: space.first,
    })
    await until(() => closedWith !== 0)
    expect(closedWith).toBe(REVOKED_CLOSE_CODE)
    const ops = await sealedOps(spaceId, second.device, { from: 1, count: 1, epoch: 2 })
    expect(
      (await space.person.json("POST", "/v1/ops", { body: { ops }, device: second.device })).body
        .error
    ).toBe("device_revoked")
    // The remaining device must now seal under epoch 2.
    const stale = await sealedOps(spaceId, space.first, { from: 1, count: 1, epoch: 1 })
    expect(
      (await space.person.json("POST", "/v1/ops", { body: { ops: stale }, device: space.first }))
        .body
    ).toMatchObject({ error: "epoch_stale", epoch: 2 })
  })

  it("refuses pushes once the log is past its read-only quota", async () => {
    const space = await spaceWithGenesis()
    const spaceId = await space.person.spaceId()
    const stub = testEnv.SYNC_SPACE.get(testEnv.SYNC_SPACE.idFromName(spaceId))
    await runInDurableObject(stub, (instance: SyncSpace) => {
      const store = (instance as unknown as { store: { oplogBytes: () => number } }).store
      store.oplogBytes = () => OPLOG_READONLY_BYTES + 1
    })
    const ops = await sealedOps(spaceId, space.first, { from: 1, count: 1 })
    expect(
      await space.person.json("POST", "/v1/ops", { body: { ops }, device: space.first })
    ).toMatchObject({
      status: 413,
      body: { error: "quota_readonly" },
    })
  })

  it("takes an op push up to 1 MiB but not past it", async () => {
    const space = await spaceWithGenesis()
    const response = await space.person.json("POST", "/v1/ops", {
      body: "x".repeat(1024 * 1024 + 1),
      device: space.first,
    })
    expect(response.status).toBe(413)
    const registry = await space.person.json("POST", "/v1/registry", {
      body: "x".repeat(64 * 1024 + 1),
      device: space.first,
    })
    expect(registry.status).toBe(413)
  })
})

describe("long-poll", () => {
  it("wakes a waiting pull when ops arrive", async () => {
    const { space, second } = await twoDevices()
    const spaceId = await space.person.spaceId()
    const waiting = space.person.json("GET", "/v1/ops?after=0&wait=10", { device: second.device })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const started = Date.now()
    const ops = await sealedOps(spaceId, space.first, { from: 1, count: 1 })
    await space.person.json("POST", "/v1/ops", { body: { ops }, device: space.first })
    const woke = await waiting
    expect(Date.now() - started).toBeLessThan(5000)
    expect(woke.body.batches).toHaveLength(1)
  })

  it("answers empty once the wait runs out, and never blocks other calls", async () => {
    const space = await spaceWithGenesis()
    const waiting = space.person.json("GET", "/v1/ops?after=0&wait=1", { device: space.first })
    // Another call to the same space goes through while the pull waits.
    expect((await space.person.json("GET", "/v1/space")).body.state).toBe("ready")
    const empty = await waiting
    expect(empty).toMatchObject({ status: 200, body: { batches: [], lastSeq: 0 } })
  })
})

describe("the socket", () => {
  it("greets with the log head and announces new ops and device-list changes", async () => {
    const { space, second } = await twoDevices()
    const spaceId = await space.person.spaceId()
    const ticket = await space.person.json("POST", "/v1/socket/ticket", { device: second.device })
    expect(ticket.status).toBe(201)
    const { socket, messages } = await openSocket(spaceId, ticket.body.ticket)
    await until(() => messages.length === 1)
    expect(messages[0]).toMatchObject({ type: "hello", lastSeq: 0 })

    const ops = await sealedOps(spaceId, space.first, { from: 1, count: 2 })
    await space.person.json("POST", "/v1/ops", { body: { ops }, device: space.first })
    await until(() => messages.length === 2)
    expect(messages[1]).toEqual({ type: "ops", lastSeq: 2 })

    await space.chain.rotateEpoch(space.first)
    await space.person.json("POST", "/v1/registry", {
      body: { entries: [space.chain.entries.at(-1)], envelopes: fakeEnvelopes(space.chain.state) },
      device: space.first,
    })
    await until(() => messages.length === 3)
    expect(messages[2]).toMatchObject({ type: "registry", head: { seq: 2 } })
    socket.close(1000, "done")
  })

  it("takes a ticket once, only within its space, and not after it expires", async () => {
    const space = await spaceWithGenesis()
    const spaceId = await space.person.spaceId()
    const ticket = (await space.person.json("POST", "/v1/socket/ticket", { device: space.first }))
      .body.ticket as string
    const other = await spaceWithGenesis()
    const elsewhere = await handleRequest(
      new Request(
        `https://sync.test/v1/socket?space=${await other.person.spaceId()}&ticket=${ticket}`,
        {
          headers: { upgrade: "websocket" },
        }
      ),
      testEnv
    )
    expect(elsewhere.status).toBe(401)
    const { socket } = await openSocket(spaceId, ticket)
    socket.close(1000, "done")
    const again = await handleRequest(
      new Request(`https://sync.test/v1/socket?space=${spaceId}&ticket=${ticket}`, {
        headers: { upgrade: "websocket" },
      }),
      testEnv
    )
    expect(again.status).toBe(401)
    const malformed = await handleRequest(
      new Request(`https://sync.test/v1/socket?space=short&ticket=x`, {
        headers: { upgrade: "websocket" },
      }),
      testEnv
    )
    expect(malformed.status).toBe(401)
  })

  it("needs an active device's proof for a ticket", async () => {
    const space = await spaceWithGenesis()
    expect((await space.person.json("POST", "/v1/socket/ticket")).status).toBe(401)
  })
})

describe("account deletion", () => {
  it("closes the space's sockets and leaves no ops behind", async () => {
    const space = await spaceWithGenesis()
    const spaceId = await space.person.spaceId()
    const ops = await sealedOps(spaceId, space.first, { from: 1, count: 2 })
    await space.person.json("POST", "/v1/ops", { body: { ops }, device: space.first })
    const ticket = await space.person.json("POST", "/v1/socket/ticket", { device: space.first })
    const { socket } = await openSocket(spaceId, ticket.body.ticket)
    let closed = false
    socket.addEventListener("close", () => {
      closed = true
    })
    await purgeSpaceOf(testEnv, space.person.userId)
    await until(() => closed)
    expect((await space.person.json("GET", "/v1/ops", { device: space.first })).body.error).toBe(
      "space_empty"
    )
  })
})
