import { identity, spaceWithFirstDevice, testContext, testServer } from "./enrollment/test-support"
import { startJoin } from "./enrollment/join"
import { recoverWithKey } from "./enrollment/recover"
import { revokeDevice } from "./enrollment/manage"
import {
  ACCOUNT_SYNC_MAX_BACKOFF_MS,
  ACCOUNT_SYNC_POLL_MS,
  pollAccountSync,
  pollDelayMs,
  requestChanges,
} from "./poll"
import type { IncomingRequest } from "./enrollment/approve"

describe("pollAccountSync", () => {
  it("is signed out without a context", async () => {
    expect(await pollAccountSync(null)).toEqual({ view: { kind: "signed-out" }, incoming: [] })
  })

  it("lists waiting devices for an enrolled device", async () => {
    const server = testServer()
    const { context } = await spaceWithFirstDevice(server)
    expect((await pollAccountSync(context)).incoming).toEqual([])
    const join = await startJoin(testContext(server, "b"), identity("Chrome"))
    const result = await pollAccountSync(context)
    expect(result.view.kind).toBe("enrolled")
    expect(result.incoming.map((r) => [r.requestId, r.displayName])).toEqual([
      [join.requestId, "Chrome"],
    ])
  })

  it("lists nothing for a device that is not enrolled", async () => {
    const server = testServer()
    await spaceWithFirstDevice(server)
    expect(await pollAccountSync(testContext(server, "x"))).toMatchObject({
      view: { kind: "not-enrolled" },
      incoming: [],
    })
  })

  it("turns a proven revocation into the removed state", async () => {
    const server = testServer()
    const first = await spaceWithFirstDevice(server)
    const second = testContext(server, "second")
    await recoverWithKey(second, first.recoveryKeyText, identity("Second"))
    const secondId = (await second.vault.loadDeviceKeys())!.deviceId
    await revokeDevice(first.context, first.device, secondId)
    expect((await pollAccountSync(second)).view).toMatchObject({
      kind: "removed",
      removal: { by: first.device.deviceId },
    })
  })
})

describe("requestChanges", () => {
  const request = (requestId: string, state: IncomingRequest["state"] = "pending") =>
    ({ requestId, state }) as IncomingRequest
  it("announces new waiting requests once and notices ended ones", () => {
    expect(requestChanges(new Set(), [request("a"), request("b", "nonce_set")])).toEqual({
      added: [request("a")],
      ended: [],
    })
    expect(requestChanges(new Set(["a"]), [request("a")])).toEqual({ added: [], ended: [] })
    expect(requestChanges(new Set(["a"]), [])).toEqual({ added: [], ended: ["a"] })
  })
})

describe("pollDelayMs", () => {
  it("polls every 20 s and backs off to five minutes", () => {
    expect(pollDelayMs(0)).toBe(ACCOUNT_SYNC_POLL_MS)
    expect(pollDelayMs(1)).toBe(40_000)
    expect(pollDelayMs(2)).toBe(80_000)
    expect(pollDelayMs(10)).toBe(ACCOUNT_SYNC_MAX_BACKOFF_MS)
  })
})
