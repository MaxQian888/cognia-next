import {
  ChainBuilder,
  makeDevice,
  makeRecovery,
  type TestDevice,
} from "@cognia/sync-protocol/testing/chain"

import {
  encodeHlc,
  encryptOpPayload,
  expectedRecipients,
  opKey,
  signOp,
  type Op,
} from "@cognia/sync-protocol"

import { sealEpochEnvelopes } from "@/lib/account-sync/crypto"
import { SyncApi, SyncApiError } from "@/lib/account-sync/sync-api"

import { createFakeSyncServer } from "./fake-sync-server"

const SPACE = "s".repeat(43)
const auth = { authorization: "Bearer t" }

describe("createFakeSyncServer", () => {
  it("answers an empty space, then accepts a genesis once", async () => {
    const server = createFakeSyncServer({ spaceId: SPACE })
    const empty = await server.fetch("https://sync.test/v1/space", { headers: auth })
    expect(await empty.json()).toEqual({ state: "empty", protocolVersion: 1 })
    expect(empty.headers.get("cognia-server-time")).toMatch(/^\d+$/)

    const chain = await ChainBuilder.genesis(SPACE, await makeDevice(), await makeRecovery())
    const body = JSON.stringify({
      entry: chain.entries[0],
      envelopes: await sealEpochEnvelopes(
        SPACE,
        1,
        chain.currentKey(),
        expectedRecipients(chain.state)
      ),
    })
    const created = await server.fetch("https://sync.test/v1/space/genesis", {
      method: "POST",
      headers: auth,
      body,
    })
    expect(created.status).toBe(200)
    expect(server.state()?.epoch).toBe(1)
    expect([...server.envelopes.keys()]).toHaveLength(2)
    const again = await server.fetch("https://sync.test/v1/space/genesis", {
      method: "POST",
      headers: auth,
      body,
    })
    expect(again.status).toBe(409)
    expect(server.calls).toEqual([
      "GET /v1/space",
      "POST /v1/space/genesis",
      "POST /v1/space/genesis",
    ])
  })

  it("needs a bearer token and a device proof where the Worker does", async () => {
    const server = createFakeSyncServer({ spaceId: SPACE })
    expect((await server.fetch("https://sync.test/v1/space")).status).toBe(401)
    const chain = await ChainBuilder.genesis(SPACE, await makeDevice(), await makeRecovery())
    await server.fetch("https://sync.test/v1/space/genesis", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        entry: chain.entries[0],
        envelopes: await sealEpochEnvelopes(
          SPACE,
          1,
          chain.currentKey(),
          expectedRecipients(chain.state)
        ),
      }),
    })
    const noProof = await server.fetch("https://sync.test/v1/envelopes/self", { headers: auth })
    expect(await noProof.json()).toEqual({ error: "bad_proof" })
    const unknown = await server.fetch(
      `https://sync.test/v1/enroll/requests/req_${"0".repeat(26)}`,
      { headers: auth }
    )
    expect(unknown.status).toBe(404)
    expect((await server.fetch("https://sync.test/v1/nope", { headers: auth })).status).toBe(404)
  })

  describe("the op log", () => {
    async function ready() {
      const server = createFakeSyncServer({ spaceId: SPACE })
      const api = new SyncApi({
        baseUrl: "https://sync.test",
        spaceId: SPACE,
        accessToken: async () => "t",
        fetchImpl: server.fetch,
      })
      const first = await makeDevice("First")
      const chain = await ChainBuilder.genesis(SPACE, first, await makeRecovery())
      await api.genesis(
        chain.entries[0]!,
        await sealEpochEnvelopes(SPACE, 1, chain.currentKey(), expectedRecipients(chain.state))
      )
      const op = async (deviceSeq: number, device: TestDevice = first, epoch = 1): Promise<Op> => {
        const header = {
          deviceId: device.deviceId,
          deviceSeq,
          hlc: { ms: 1_000 + deviceSeq, c: 0 },
          epoch,
          schemaVer: 1,
          cls: "c" as const,
        }
        const sealed = await encryptOpPayload(
          await opKey(chain.currentKey(), SPACE),
          SPACE,
          header,
          {
            t: "sessions",
            id: `s${deviceSeq}`,
            k: "upsert",
            f: { title: ["T", encodeHlc({ ...header.hlc, deviceId: device.deviceId })] },
          }
        )
        return signOp(device.sign.privateKey, SPACE, { ...header, ...sealed })
      }
      return { server, api, first, op }
    }

    async function refusal(promise: Promise<unknown>): Promise<SyncApiError> {
      const error = await promise.then(
        () => null,
        (caught: unknown) => caught
      )
      expect(error).toBeInstanceOf(SyncApiError)
      return error as SyncApiError
    }

    it("stores pushes in order, acknowledges a repeat, and serves what follows a cursor", async () => {
      const { server, api, first, op } = await ready()
      expect(await api.pushOps(first, [await op(1), await op(2)])).toEqual({
        deviceSeq: 2,
        firstSeq: 1,
        lastSeq: 2,
      })
      expect(await api.pushOps(first, [await op(2)])).toEqual({
        deviceSeq: 2,
        firstSeq: null,
        lastSeq: null,
      })
      await api.pushOps(first, [await op(3)])
      expect(server.batches.map((batch) => [batch.firstSeq, batch.lastSeq])).toEqual([
        [1, 2],
        [3, 3],
      ])
      const view = await api.pullOps(first, 2)
      expect(view.batches.map((batch) => batch.firstSeq)).toEqual([3])
      expect(view).toMatchObject({ more: false, lastSeq: 3, registryHead: server.state()!.head })
    })

    it("refuses a gap, a stale epoch, a forged signature and another device's op", async () => {
      const { api, first, op } = await ready()
      expect(await refusal(api.pushOps(first, [await op(2)]))).toMatchObject({
        code: "seq_gap",
        status: 409,
        details: { expected: 1 },
      })
      expect(await refusal(api.pushOps(first, [await op(1, first, 2)]))).toMatchObject({
        code: "epoch_stale",
        details: { epoch: 1 },
      })
      const forged = { ...(await op(1)), ct: (await op(1)).ct.slice(1) }
      expect((await refusal(api.pushOps(first, [forged]))).status).toBe(400)
      const stranger = await makeDevice("Stranger")
      expect((await refusal(api.pushOps(first, [await op(1, stranger)]))).status).toBe(400)
      expect((await refusal(api.pushOps(first, []))).status).toBe(400)
    })

    it("holds a waiting pull until the next push", async () => {
      const { server, api, first, op } = await ready()
      const waiting = api.pullOps(first, 0, 25)
      const pushed = server.nextPush()
      await api.pushOps(first, [await op(1)])
      await pushed
      expect((await waiting).batches).toHaveLength(1)
    })

    it("issues a socket ticket bound to the device", async () => {
      const { server, api, first } = await ready()
      const { ticket, expiresAt } = await api.socketTicket(first)
      expect(server.tickets.get(ticket)).toBe(first.deviceId)
      expect(expiresAt).toBeGreaterThan(Date.now())
    })
  })
})
