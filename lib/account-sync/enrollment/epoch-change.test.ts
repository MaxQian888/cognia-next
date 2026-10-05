import { expectedRecipients, validateAppend } from "@cognia/sync-protocol"

import { nextEpoch, sealEpochEnvelopes, signRegistryEntry, type DeviceKeys } from "../crypto"
import { currentKeyChain, verifyRegistry } from "../registry-sync"
import type { AccountSyncContext } from "./context"
import { appendEpochChange } from "./epoch-change"
import { recoverWithKey } from "./recover"
import { identity, spaceWithFirstDevice, testContext, testServer } from "./test-support"

/** A rotation without the space lock, as another tab or device would race it. */
async function rotateDirectly(context: AccountSyncContext, device: DeviceKeys): Promise<void> {
  const { state } = (await verifyRegistry(context.api, context.vault))!
  const chain = await currentKeyChain(context.api, context.vault, state, device)
  const { block, key } = await nextEpoch(state, chain)
  const signed = await signRegistryEntry(
    {
      v: 1,
      spaceId: state.spaceId,
      seq: state.head.seq + 1,
      prev: state.head.hash,
      at: Date.now(),
      type: "epoch-rotate",
      epoch: block,
    },
    [{ kind: "device", keys: device }]
  )
  const next = (await validateAppend(state, signed, state.spaceId)).state
  await context.api.append(
    device,
    [signed],
    await sealEpochEnvelopes(state.spaceId, next.epoch, key, expectedRecipients(next))
  )
}

describe("appendEpochChange", () => {
  it("retries once when the head moved under it", async () => {
    const server = testServer()
    const first = await spaceWithFirstDevice(server)
    let armed = false
    // Another device appends between this device's read and its append.
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (armed && request.method === "POST" && new URL(request.url).pathname === "/v1/registry") {
        armed = false
        await rotateDirectly(first.context, first.device)
      }
      return server.fetch(request)
    }) as typeof fetch
    const context = testContext(server, "racer", fetchImpl)
    await recoverWithKey(context, first.recoveryKeyText, identity("Racer"))
    const racer = (await context.vault.loadDeviceKeys())!
    const before = server.state()!.epoch
    armed = true
    const state = await appendEpochChange(context, racer, (base, block) => ({
      ...base,
      type: "epoch-rotate",
      epoch: block,
    }))
    expect(armed).toBe(false)
    expect(state.epoch).toBe(before + 2)
    expect(server.state()!.epoch).toBe(before + 2)
  })

  it("refuses a device that is not active", async () => {
    const server = testServer()
    const { device } = await spaceWithFirstDevice(server)
    const stranger = testContext(server, "stranger")
    await expect(
      appendEpochChange(
        stranger,
        { ...device, deviceId: "dev_00000000000000000000000000" },
        (base, block) => ({
          ...base,
          type: "epoch-rotate",
          epoch: block,
        })
      )
    ).rejects.toMatchObject({ code: "not-enrolled" })
  })
})
