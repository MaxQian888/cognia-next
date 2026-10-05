import { expectedRecipients, newEpochKey, pinFor } from "@cognia/sync-protocol"
import { ChainBuilder, makeDevice, makeRecovery } from "@cognia/sync-protocol/testing/chain"

import {
  AccountSyncCryptoError,
  sealEpochEnvelope,
  sealEpochEnvelopes,
} from "@/lib/account-sync/crypto"

import { RegistryIntegrityError, currentKeyChain, verifyRegistry } from "./registry-sync"
import { SyncApi } from "./sync-api"
import { createFakeSyncServer } from "./testing/fake-sync-server"
import { createMemoryKeyring } from "./testing/memory-keyring"
import { __clearAccountSyncKeyCache, createAccountSyncVault } from "./vault-store"

const SPACE = "s".repeat(43)

beforeEach(() => __clearAccountSyncKeyCache())

async function setup(rewrite?: (path: string, response: Response) => Promise<Response>) {
  const server = createFakeSyncServer({ spaceId: SPACE })
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await server.fetch(input, init)
    return rewrite ? rewrite(new URL(String(input)).pathname, response) : response
  }) as typeof fetch
  const api = new SyncApi({
    baseUrl: "https://sync.test",
    spaceId: SPACE,
    accessToken: async () => "t",
    fetchImpl,
  })
  const vault = createAccountSyncVault(
    { localAccountId: "local_1", spaceId: SPACE },
    createMemoryKeyring()
  )
  const first = await makeDevice("First")
  const chain = await ChainBuilder.genesis(SPACE, first, await makeRecovery())
  await api.genesis(
    chain.entries[0]!,
    await sealEpochEnvelopes(SPACE, 1, chain.currentKey(), expectedRecipients(chain.state))
  )
  return { server, api, vault, first, chain }
}

async function rotate(
  api: SyncApi,
  chain: ChainBuilder,
  signer: Awaited<ReturnType<typeof makeDevice>>
) {
  const entry = await chain.rotateEpoch(signer)
  await api.append(
    signer,
    [entry],
    await sealEpochEnvelopes(
      SPACE,
      chain.epoch,
      chain.currentKey(),
      expectedRecipients(chain.state)
    )
  )
}

describe("verifyRegistry", () => {
  it("folds the list and moves the pin", async () => {
    const { api, vault, chain, first } = await setup()
    await rotate(api, chain, first)
    const folded = await verifyRegistry(api, vault)
    expect(folded!.state).toEqual(chain.state)
    expect(await vault.loadPin()).toEqual(pinFor(chain.state))
  })

  it("refuses a shorter list than the one it verified, and keeps the pin", async () => {
    let truncate = false
    const { api, vault, chain, first } = await setup(async (path, response) => {
      if (!truncate || path !== "/v1/registry") return response
      const body = (await response.json()) as { entries: unknown[] }
      return Response.json({ ...body, entries: body.entries.slice(0, 1) })
    })
    await rotate(api, chain, first)
    await verifyRegistry(api, vault)
    truncate = true
    const error = await verifyRegistry(api, vault).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RegistryIntegrityError)
    expect((error as RegistryIntegrityError).reason).toBe("rollback")
    expect((await vault.loadPin())!.seq).toBe(1)
  })
})

describe("currentKeyChain", () => {
  it("opens this device's envelope once, then serves the stored chain", async () => {
    const { server, api, vault, chain, first } = await setup()
    await rotate(api, chain, first)
    const state = (await verifyRegistry(api, vault))!.state
    const keys = await currentKeyChain(api, vault, state, first)
    expect(keys.get(2)).toEqual(chain.epochKeys.get(2))
    expect(keys.get(1)).toEqual(chain.epochKeys.get(1))
    const calls = server.calls.length
    await currentKeyChain(api, vault, state, first)
    expect(server.calls.length).toBe(calls)
  })

  it("refuses a key the server sealed itself", async () => {
    const { api, vault, first } = await setup(async (path, response) => {
      if (path !== "/v1/envelopes/self") return response
      const forged = await sealEpochEnvelope(SPACE, 1, newEpochKey(), {
        recipient: first.deviceId,
        encPub: first.encPub,
      })
      return Response.json({ envelope: forged })
    })
    const state = (await verifyRegistry(api, vault))!.state
    const error = await currentKeyChain(api, vault, state, first).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AccountSyncCryptoError)
    expect((error as AccountSyncCryptoError).code).toBe("key_commitment")
    expect(await vault.loadKeyChain()).toBeNull()
  })
})
