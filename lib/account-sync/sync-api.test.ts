import { expectedRecipients } from "@cognia/sync-protocol"
import { ChainBuilder, makeDevice, makeRecovery } from "@cognia/sync-protocol/testing/chain"

import { sealEpochEnvelopes } from "@/lib/account-sync/crypto"

import { SyncApi, SyncApiError } from "./sync-api"
import { createFakeSyncServer } from "./testing/fake-sync-server"

const SPACE = "s".repeat(43)

async function setup(serverNow?: () => number) {
  const server = createFakeSyncServer({ spaceId: SPACE, now: serverNow })
  const api = new SyncApi({
    baseUrl: "https://sync.test",
    spaceId: SPACE,
    accessToken: async () => "token",
    fetchImpl: server.fetch,
  })
  const first = await makeDevice("First")
  const chain = await ChainBuilder.genesis(SPACE, first, await makeRecovery())
  return { server, api, first, chain }
}

async function errorOf(promise: Promise<unknown>): Promise<SyncApiError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(SyncApiError)
  return error as SyncApiError
}

describe("SyncApi", () => {
  it("creates a space and reads it back", async () => {
    const { api, chain } = await setup()
    expect(await api.space()).toEqual({ state: "empty", protocolVersion: 1 })
    await api.genesis(
      chain.entries[0]!,
      await sealEpochEnvelopes(SPACE, 1, chain.currentKey(), expectedRecipients(chain.state))
    )
    expect(await api.space()).toMatchObject({
      state: "ready",
      epoch: 1,
      genesisHash: chain.state.genesisHash,
    })
    expect(await api.registry()).toHaveLength(1)
    expect((await api.recoveryEnvelope()).recipient).toBe("recovery")
  })

  it("signs device proofs the server accepts", async () => {
    const { api, chain, first } = await setup()
    await api.genesis(
      chain.entries[0]!,
      await sealEpochEnvelopes(SPACE, 1, chain.currentKey(), expectedRecipients(chain.state))
    )
    expect((await api.selfEnvelope(first)).recipient).toBe(first.deviceId)
    expect(await api.listRequests(first)).toEqual([])
    const rotate = await chain.rotateEpoch(first)
    await api.append(
      first,
      [rotate],
      await sealEpochEnvelopes(SPACE, 2, chain.currentKey(), expectedRecipients(chain.state))
    )
    expect((await api.space()).epoch).toBe(2)
  })

  it("corrects its clock from the server and retries a clock_skew refusal once", async () => {
    const ahead = 10 * 60 * 1000
    const { api, chain, first } = await setup(() => Date.now() + ahead)
    await api.genesis(
      chain.entries[0]!,
      await sealEpochEnvelopes(SPACE, 1, chain.currentKey(), expectedRecipients(chain.state))
    )
    // The genesis answer already taught the offset; reset it to force a refusal first.
    ;(api as unknown as { clockOffset: number }).clockOffset = 0
    expect((await api.selfEnvelope(first)).recipient).toBe(first.deviceId)
    expect(api.serverClockOffset).toBeGreaterThan(ahead - 5_000)
    expect(Math.abs(api.serverNow() - (Date.now() + ahead))).toBeLessThan(5_000)
  })

  it("follows registry pages", async () => {
    const pages = [
      { entries: [{ a: 0 }, { a: 1 }], more: true },
      { entries: [{ a: 2 }], more: false },
    ]
    const seen: string[] = []
    const api = new SyncApi({
      baseUrl: "https://sync.test",
      spaceId: SPACE,
      accessToken: async () => "t",
      fetchImpl: (async (url: string) => {
        seen.push(new URL(url).search)
        return Response.json(pages.shift())
      }) as unknown as typeof fetch,
    })
    expect(await api.registry()).toEqual([{ a: 0 }, { a: 1 }, { a: 2 }])
    expect(seen).toEqual(["", "?after=1"])
  })

  it("names its failures", async () => {
    const signedOut = new SyncApi({
      baseUrl: "https://sync.test",
      spaceId: SPACE,
      accessToken: async () => null,
      fetchImpl: fetch,
    })
    expect((await errorOf(signedOut.space())).code).toBe("signed_out")

    const offline = new SyncApi({
      baseUrl: "https://sync.test",
      spaceId: SPACE,
      accessToken: async () => "t",
      fetchImpl: (async () => Promise.reject(new TypeError("offline"))) as unknown as typeof fetch,
    })
    expect((await errorOf(offline.space())).code).toBe("network")

    const broken = new SyncApi({
      baseUrl: "https://sync.test",
      spaceId: SPACE,
      accessToken: async () => "t",
      fetchImpl: (async () => new Response("boom", { status: 502 })) as unknown as typeof fetch,
    })
    expect(await errorOf(broken.space())).toMatchObject({ code: "server", status: 502 })

    const { api } = await setup()
    expect(await errorOf(api.recoveryEnvelope())).toMatchObject({
      code: "space_empty",
      status: 409,
    })
  })

  it("asks for ops after a cursor, waits only when told, and refuses a malformed answer", async () => {
    const seen: string[] = []
    let answer: unknown = { batches: [], more: false, lastSeq: 0, registryHead: null }
    const api = new SyncApi({
      baseUrl: "https://sync.test",
      spaceId: SPACE,
      accessToken: async () => "t",
      fetchImpl: (async (url: string) => {
        seen.push(new URL(url).search)
        return Response.json(answer)
      }) as unknown as typeof fetch,
    })
    const device = await makeDevice()
    await api.pullOps(device, 7)
    await api.pullOps(device, 7, 25)
    expect(seen).toEqual(["?after=7", "?after=7&wait=25"])
    answer = { more: false }
    expect(await errorOf(api.pullOps(device, 0))).toMatchObject({ code: "server" })
  })

  it("keeps a refusal's details", async () => {
    const api = new SyncApi({
      baseUrl: "https://sync.test",
      spaceId: SPACE,
      accessToken: async () => "t",
      fetchImpl: (async () =>
        Response.json(
          { error: "seq_gap", message: "gap", expected: 4 },
          { status: 409 }
        )) as unknown as typeof fetch,
    })
    const error = await errorOf(api.pushOps(await makeDevice(), []))
    expect(error).toMatchObject({ code: "seq_gap", status: 409, message: "gap" })
    expect(error.details).toEqual({ expected: 4 })
  })

  it("addresses the live socket over ws or wss with the space and ticket", () => {
    const at = (baseUrl: string) =>
      new SyncApi({ baseUrl, spaceId: SPACE, accessToken: async () => "t", fetchImpl: fetch })
    expect(at("https://sync.test").socketUrl("tk")).toBe(
      `wss://sync.test/v1/socket?space=${SPACE}&ticket=tk`
    )
    expect(at("http://localhost:8788").socketUrl("tk")).toBe(
      `ws://localhost:8788/v1/socket?space=${SPACE}&ticket=tk`
    )
  })
})
