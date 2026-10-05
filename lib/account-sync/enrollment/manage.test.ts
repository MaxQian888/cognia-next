import { RECOVERY_SIGNER } from "@cognia/sync-protocol"

import { commitRecoveryKey, prepareRecoveryKey, revokeDevice, rotateKeys } from "./manage"
import { recoverWithKey } from "./recover"
import { identity, spaceWithFirstDevice, testContext, testServer } from "./test-support"

describe("managing devices", () => {
  it("rotates the keys", async () => {
    const server = testServer()
    const { context, device } = await spaceWithFirstDevice(server)
    const state = await rotateKeys(context, device)
    expect(state.epoch).toBe(2)
    expect([...(await context.vault.loadKeyChain())!.keys()].sort()).toEqual([1, 2])
    expect((await context.vault.loadPin())!.epoch).toBe(2)
  })

  it("removes another device and seals the new key only to those who stay", async () => {
    const server = testServer()
    const first = await spaceWithFirstDevice(server)
    const second = testContext(server, "second")
    await recoverWithKey(second, first.recoveryKeyText, identity("Second"))
    const secondId = (await second.vault.loadDeviceKeys())!.deviceId
    const state = await revokeDevice(first.context, first.device, secondId)
    expect(state.devices[secondId]!.status).toBe("revoked")
    expect([...server.envelopes.keys()].sort()).toEqual(
      [first.device.deviceId, RECOVERY_SIGNER].sort()
    )
  })

  it("refuses to remove itself", async () => {
    const server = testServer()
    const { context, device } = await spaceWithFirstDevice(server)
    await expect(revokeDevice(context, device, device.deviceId)).rejects.toThrow()
  })

  it("replaces the recovery key only after it is committed", async () => {
    const server = testServer()
    const { context, device } = await spaceWithFirstDevice(server)
    const before = server.state()!.recovery
    const prepared = await prepareRecoveryKey(context)
    expect(server.state()!.recovery).toEqual(before)
    const state = await commitRecoveryKey(context, device, prepared)
    expect(state.recovery).toEqual({ signPub: prepared.keys.signPub, encPub: prepared.keys.encPub })
    expect(server.envelopes.get(RECOVERY_SIGNER)?.recipientEncPub).toBe(prepared.keys.encPub)
    expect(prepared.recoveryKey.every((byte) => byte === 0)).toBe(true)
  })
})
