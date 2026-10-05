import { parseRecoveryKey, pinFor } from "@cognia/sync-protocol"

import { deriveRecoveryKeys } from "../crypto"
import { commitFirstDevice, prepareFirstDevice } from "./first-device"
import { identity, testContext, testServer, TEST_SPACE } from "./test-support"

describe("first device", () => {
  it("prepares everything locally and uploads nothing", async () => {
    const server = testServer()
    const context = testContext(server, "a")
    const prepared = await prepareFirstDevice(context, identity("MacBook", "desktop"))
    expect(server.calls).toEqual([])
    expect(prepared.state.epoch).toBe(1)
    expect(prepared.envelopes.map((e) => e.recipient).sort()).toEqual(
      [prepared.material.deviceId, "recovery"].sort()
    )
    const derived = await deriveRecoveryKeys(parseRecoveryKey(prepared.recoveryKeyText), TEST_SPACE)
    expect(prepared.state.recovery).toEqual({ signPub: derived.signPub, encPub: derived.encPub })
    expect(await context.vault.loadDeviceKeys()).toBeNull()
  })

  it("keeps keys, key chain and pin only after the server accepted", async () => {
    const server = testServer()
    const context = testContext(server, "a")
    const prepared = await prepareFirstDevice(context, identity("MacBook", "desktop"))
    const result = await commitFirstDevice(context, prepared)
    expect(result.kind).toBe("created")
    expect((await context.vault.loadDeviceKeys())!.deviceId).toBe(prepared.material.deviceId)
    expect((await context.vault.loadKeyChain())!.get(1)).toEqual(prepared.epochKey)
    expect(await context.vault.loadPin()).toEqual(pinFor(prepared.state))
    expect(prepared.recoveryKey.every((byte) => byte === 0)).toBe(true)
  })

  it("keeps nothing when the server refuses", async () => {
    const server = testServer()
    const context = testContext(
      server,
      "a",
      (async () =>
        new Response(JSON.stringify({ error: "invalid_entry" }), {
          status: 400,
        })) as unknown as typeof fetch
    )
    const prepared = await prepareFirstDevice(context, identity("MacBook", "desktop"))
    await expect(commitFirstDevice(context, prepared)).rejects.toMatchObject({
      code: "invalid_entry",
    })
    expect(await context.vault.loadDeviceKeys()).toBeNull()
  })
})
