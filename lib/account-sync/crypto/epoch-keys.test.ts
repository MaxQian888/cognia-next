import { newEpochKey, type RegistryState } from "@cognia/sync-protocol"
import {
  ChainBuilder,
  deviceSigner,
  makeDevice,
  makeRecovery,
  signWith,
} from "@cognia/sync-protocol/testing/chain"

import { AccountSyncCryptoError } from "./errors"
import {
  firstEpoch,
  matchesCurrentEpoch,
  nextEpoch,
  parseKeyChain,
  serializeKeyChain,
  verifiedKeyChain,
} from "./epoch-keys"

const SPACE = "s".repeat(43)

async function chainAtEpoch3() {
  const first = await makeDevice()
  const chain = await ChainBuilder.genesis(SPACE, first, await makeRecovery())
  await chain.rotateEpoch(first)
  await chain.rotateEpoch(first)
  return { chain, first }
}

describe("verifiedKeyChain", () => {
  it("recovers every earlier key from the current one", async () => {
    const { chain } = await chainAtEpoch3()
    const keys = await verifiedKeyChain(chain.state, chain.currentKey())
    expect([...keys.keys()].sort()).toEqual([1, 2, 3])
    for (const epoch of [1, 2, 3]) expect(keys.get(epoch)).toEqual(chain.epochKeys.get(epoch))
  })

  it("refuses a current key the registry does not commit to", async () => {
    const { chain } = await chainAtEpoch3()
    await expect(verifiedKeyChain(chain.state, newEpochKey())).rejects.toMatchObject({
      code: "key_commitment",
    })
    await expect(verifiedKeyChain(chain.state, chain.epochKeys.get(2)!)).rejects.toThrow(
      AccountSyncCryptoError
    )
  })

  it("refuses a chain whose wraps or commitments were tampered with", async () => {
    const { chain } = await chainAtEpoch3()
    const swappedWrap: RegistryState = {
      ...chain.state,
      prevWraps: { ...chain.state.prevWraps, 3: chain.state.prevWraps[2]! },
    }
    await expect(verifiedKeyChain(swappedWrap, chain.currentKey())).rejects.toMatchObject({
      code: "key_commitment",
    })
    const missingWrap: RegistryState = {
      ...chain.state,
      prevWraps: { 2: chain.state.prevWraps[2]! },
    }
    await expect(verifiedKeyChain(missingWrap, chain.currentKey())).rejects.toThrow(/wrap/)
    const wrongCommit: RegistryState = {
      ...chain.state,
      keyCommits: { ...chain.state.keyCommits, 1: chain.state.keyCommits[2]! },
    }
    await expect(verifiedKeyChain(wrongCommit, chain.currentKey())).rejects.toThrow(/epoch 1/)
  })
})

describe("matchesCurrentEpoch", () => {
  it("is true only for a chain holding the committed current key", async () => {
    const { chain, first } = await chainAtEpoch3()
    const keys = await verifiedKeyChain(chain.state, chain.currentKey())
    expect(await matchesCurrentEpoch(chain.state, keys)).toBe(true)
    await chain.rotateEpoch(first)
    expect(await matchesCurrentEpoch(chain.state, keys)).toBe(false)
    expect(await matchesCurrentEpoch(chain.state, new Map([[4, newEpochKey()]]))).toBe(false)
  })
})

describe("nextEpoch / firstEpoch", () => {
  it("starts epoch 1 with a committed key", async () => {
    const { block, key } = await firstEpoch(SPACE)
    expect(block.epoch).toBe(1)
    expect(block.prevWrap).toBeUndefined()
    const first = await makeDevice()
    const chain = await ChainBuilder.genesis(SPACE, first, await makeRecovery())
    const state = { ...chain.state, keyCommits: { 1: block.keyCommit } }
    expect((await verifiedKeyChain(state, key)).get(1)).toEqual(key)
  })

  it("produces a block the registry accepts and a key that walks back", async () => {
    const { chain, first } = await chainAtEpoch3()
    const keys = await verifiedKeyChain(chain.state, chain.currentKey())
    const { block, key } = await nextEpoch(chain.state, keys)
    expect(block.epoch).toBe(4)
    await chain.push(
      await signWith({ ...chain.base(), type: "epoch-rotate", epoch: block }, [deviceSigner(first)])
    )
    const after = await verifiedKeyChain(chain.state, key)
    expect(after.get(3)).toEqual(keys.get(3))
    expect(after.get(1)).toEqual(keys.get(1))
  })

  it("needs the current epoch key", async () => {
    const { chain } = await chainAtEpoch3()
    await expect(nextEpoch(chain.state, new Map([[1, newEpochKey()]]))).rejects.toThrow(
      /current epoch key/
    )
  })
})

describe("key chain storage", () => {
  it("round-trips", async () => {
    const { chain } = await chainAtEpoch3()
    const keys = await verifiedKeyChain(chain.state, chain.currentKey())
    expect(parseKeyChain(serializeKeyChain(keys))).toEqual(keys)
  })

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["epoch 0", '{"0":"' + "A".repeat(43) + '"}'],
    ["a non-canonical epoch", '{"01":"' + "A".repeat(43) + '"}'],
    ["a short key", '{"1":"AAAA"}'],
    ["a non-string key", '{"1":5}'],
    ["bad base64url", '{"1":"' + "*".repeat(43) + '"}'],
  ])("refuses %s", (_label, text) => {
    expect(() => parseKeyChain(text)).toThrow(expect.objectContaining({ code: "bad_key_material" }))
  })
})
