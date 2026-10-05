import { ChainBuilder, makeDevice, makeRecovery } from "@cognia/sync-protocol/testing/chain"

import { expectedRecipients } from "@cognia/sync-protocol"

import { sealEpochEnvelopes } from "@/lib/account-sync/crypto"

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
})
