import { toBase64Url } from "../bytes"
import { RegistryError, type RegistryErrorCode } from "../errors"
import {
  ChainBuilder,
  deviceSigner,
  makeDevice,
  makeRecovery,
  recoverySigner,
  signWith,
} from "../testing/chain"
import { foldRegistry } from "./fold"
import { pinFor } from "./pin"
import type { RegistryEntry } from "./types"

const SPACE = "s".repeat(43)

async function expectRefused(promise: Promise<unknown>, code: RegistryErrorCode): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(RegistryError)
  expect((error as RegistryError).code).toBe(code)
}

/** Genesis, an approval, a recovery batch, a revoke, a recovery change and a rotation. */
async function fullChain() {
  const first = await makeDevice("First")
  const recovery = await makeRecovery()
  const chain = await ChainBuilder.genesis(SPACE, first, recovery)
  const second = await makeDevice("Second", "web")
  await chain.addByApproval(first, second)
  const phone = await makeDevice("Phone", "mobile")
  await chain.addByRecovery(recovery, phone)
  await chain.revoke(phone, second.deviceId)
  const nextRecovery = await makeRecovery()
  await chain.rotateRecovery(first, nextRecovery)
  await chain.rotateEpoch(phone)
  return { chain, first, second, phone, recovery, nextRecovery }
}

describe("foldRegistry", () => {
  it("returns null for an empty space this device never verified", async () => {
    await expect(foldRegistry([], { spaceId: SPACE })).resolves.toBeNull()
    await expect(foldRegistry([], { spaceId: SPACE, pin: null })).resolves.toBeNull()
  })

  it("folds a whole chain to the state the builder reached", async () => {
    const { chain, first, second, phone, nextRecovery } = await fullChain()
    const folded = (await foldRegistry(JSON.parse(JSON.stringify(chain.entries)), {
      spaceId: SPACE,
    }))!
    expect(folded.state).toEqual(chain.state)
    expect(folded.entries).toHaveLength(chain.entries.length)
    expect(folded.entries.at(-1)!.hash).toBe(chain.state.head.hash)
    expect(folded.state.epoch).toBe(5)
    expect(folded.state.recovery.signPub).toBe(nextRecovery.signPub)
    expect(folded.state.devices[second.deviceId]!.status).toBe("revoked")
    expect(folded.state.devices[first.deviceId]!.status).toBe("active")
    expect(folded.state.devices[phone.deviceId]!.status).toBe("active")
    expect(Object.keys(folded.state.prevWraps).map(Number)).toEqual([2, 3, 4, 5])
  }, 30_000)

  it("accepts the same or a longer chain than the pin", async () => {
    const { chain, first } = await fullChain()
    const pin = pinFor(chain.state)
    await expect(foldRegistry(chain.entries, { spaceId: SPACE, pin })).resolves.not.toBeNull()
    await chain.rotateEpoch(first)
    await expect(foldRegistry(chain.entries, { spaceId: SPACE, pin })).resolves.not.toBeNull()
  }, 30_000)

  it("refuses an empty answer once the device has pinned the space", async () => {
    const { chain } = await fullChain()
    await expectRefused(foldRegistry([], { spaceId: SPACE, pin: pinFor(chain.state) }), "rollback")
  }, 30_000)

  it("refuses a truncated chain (rollback)", async () => {
    const { chain } = await fullChain()
    const pin = pinFor(chain.state)
    await expectRefused(
      foldRegistry(chain.entries.slice(0, -1), { spaceId: SPACE, pin }),
      "rollback"
    )
  }, 30_000)

  it("refuses a chain that differs at the pinned position (fork)", async () => {
    const first = await makeDevice()
    const chain = await ChainBuilder.genesis(SPACE, first, await makeRecovery())
    await chain.rotateEpoch(first)
    const pin = pinFor(chain.state)

    // The server rewrites history from the pinned genesis: same seq, another entry.
    const forked = chain.fork()
    forked.entries.pop()
    forked.state = (await foldRegistry(forked.entries, { spaceId: SPACE }))!.state
    await forked.rotateEpoch(first)
    await forked.rotateEpoch(first)
    expect(forked.entries[1]).not.toEqual(chain.entries[1])
    await expectRefused(foldRegistry(forked.entries, { spaceId: SPACE, pin }), "fork")
  })

  it("refuses a chain from another genesis (fork)", async () => {
    const first = await makeDevice()
    const chain = await ChainBuilder.genesis(SPACE, first, await makeRecovery())
    const other = await ChainBuilder.genesis(SPACE, first, await makeRecovery())
    await other.rotateEpoch(first)
    await expectRefused(
      foldRegistry(other.entries, { spaceId: SPACE, pin: pinFor(chain.state) }),
      "fork"
    )
  })

  it("refuses a chain that ends inside a recovery batch", async () => {
    const first = await makeDevice()
    const recovery = await makeRecovery()
    const chain = await ChainBuilder.genesis(SPACE, first, recovery)
    const phone = await makeDevice()
    const add: RegistryEntry = {
      ...chain.base(),
      type: "add-device",
      via: "recovery",
      device: await chain.descriptor(phone),
    }
    const elements = [
      ...chain.entries,
      await signWith(add, [recoverySigner(recovery), deviceSigner(phone)]),
    ]
    await expectRefused(foldRegistry(elements, { spaceId: SPACE }), "incomplete_batch")
  })

  it("refuses any invalid element on the way", async () => {
    const { chain } = await fullChain()
    const elements = JSON.parse(JSON.stringify(chain.entries))
    elements[3].sigs[0].sig = toBase64Url(new Uint8Array(64).fill(9))
    await expectRefused(foldRegistry(elements, { spaceId: SPACE }), "bad_signature")
    await expectRefused(foldRegistry(chain.entries.slice(1), { spaceId: SPACE }), "bad_genesis")
    const reordered = [...chain.entries]
    ;[reordered[1], reordered[2]] = [reordered[2]!, reordered[1]!]
    await expectRefused(foldRegistry(reordered, { spaceId: SPACE }), "bad_link")
  }, 30_000)
})
