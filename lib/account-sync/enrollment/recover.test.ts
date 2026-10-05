import { RECOVERY_SIGNER } from "@cognia/sync-protocol"

import { recoverWithKey } from "./recover"
import { identity, spaceWithFirstDevice, testContext, testServer } from "./test-support"

describe("recoverWithKey", () => {
  it("adds this device and rotates in one batch", async () => {
    const server = testServer()
    const { recoveryKeyText } = await spaceWithFirstDevice(server)
    const phone = testContext(server, "phone")
    const registry = await recoverWithKey(
      phone,
      recoveryKeyText.replaceAll("-", " ").toLowerCase(),
      identity("Phone", "mobile")
    )
    expect(registry.state.epoch).toBe(2)
    const keys = (await phone.vault.loadDeviceKeys())!
    expect(registry.state.devices[keys.deviceId]).toMatchObject({
      addedVia: "recovery",
      status: "active",
    })
    expect([...(await phone.vault.loadKeyChain())!.keys()].sort()).toEqual([1, 2])
    expect(server.entries.slice(-2).map((e) => e.entry.type)).toEqual([
      "add-device",
      "epoch-rotate",
    ])
    expect(server.envelopes.get(RECOVERY_SIGNER)?.epoch).toBe(2)
  })

  it("refuses another account's recovery key and malformed input", async () => {
    const server = testServer()
    await spaceWithFirstDevice(server)
    const other = testServer()
    const { recoveryKeyText: foreign } = await spaceWithFirstDevice(other, "elsewhere")
    const phone = testContext(server, "phone")
    // Same space id in tests, but a different key: the derived keys differ.
    await expect(recoverWithKey(phone, foreign, identity("Phone"))).rejects.toMatchObject({
      code: "recovery_mismatch",
    })
    await expect(recoverWithKey(phone, "not a key", identity("Phone"))).rejects.toThrow()
    expect(await phone.vault.loadDeviceKeys()).toBeNull()
  })

  it("needs a space", async () => {
    await expect(
      recoverWithKey(
        testContext(testServer(), "p"),
        "0000-0000-0000-0000-0000-0000-00",
        identity("P")
      )
    ).rejects.toMatchObject({
      code: "space-empty",
    })
  })
})
