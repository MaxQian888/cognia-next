import { verifyRegistry } from "../registry-sync"
import { revokeDevice } from "./manage"
import { recoverWithKey } from "./recover"
import { applyRevocation, handleRevokedAnswer, provenRemoval } from "./revoked"
import { identity, spaceWithFirstDevice, testContext, testServer } from "./test-support"

async function twoDevices() {
  const server = testServer()
  const first = await spaceWithFirstDevice(server)
  const second = testContext(server, "second")
  await recoverWithKey(second, first.recoveryKeyText, identity("Second"))
  return { server, first, second, secondKeys: (await second.vault.loadDeviceKeys())! }
}

describe("revocation", () => {
  it("proves nothing while the device is active", async () => {
    const { second, secondKeys } = await twoDevices()
    const registry = (await verifyRegistry(second.api, second.vault))!
    expect(provenRemoval(registry, secondKeys)).toBeNull()
    expect(await applyRevocation(second, registry, secondKeys)).toBeNull()
    expect(await handleRevokedAnswer(second, secondKeys)).toBeNull()
    expect(await second.vault.loadDeviceKeys()).not.toBeNull()
  })

  it("forgets the keys once the signed list removes the device", async () => {
    const { first, second, secondKeys } = await twoDevices()
    const state = await revokeDevice(first.context, first.device, secondKeys.deviceId)
    const removal = await handleRevokedAnswer(second, secondKeys)
    expect(removal).toEqual({
      at: expect.any(Number),
      seq: state.head.seq,
      by: first.device.deviceId,
    })
    expect(await second.vault.loadDeviceKeys()).toBeNull()
    expect(await second.vault.loadRemoval()).toEqual(removal)
  })

  it("does not act on a revoked entry for another key under the same id", async () => {
    const { first, second, secondKeys } = await twoDevices()
    await revokeDevice(first.context, first.device, secondKeys.deviceId)
    const registry = (await verifyRegistry(first.context.api, first.context.vault))!
    expect(
      provenRemoval(registry, { deviceId: secondKeys.deviceId, signPub: first.device.signPub })
    ).toBeNull()
    void second
  })
})
