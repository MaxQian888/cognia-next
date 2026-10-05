import { beginApproval, confirmApproval, denyRequest, listIncoming, pollApproval } from "./approve"
import { pollJoin, startJoin } from "./join"
import { identity, spaceWithFirstDevice, testContext, testServer } from "./test-support"

async function pending() {
  const server = testServer()
  const first = await spaceWithFirstDevice(server)
  const b = testContext(server, "b")
  const join = await startJoin(b, identity("Pixel 9 · 工作", "mobile"))
  return { server, first, b, join }
}

describe("approving a new device", () => {
  it("lists requests with the name sealed to this device", async () => {
    const { first, join } = await pending()
    const [incoming] = await listIncoming(first.context, first.device)
    expect(incoming).toMatchObject({
      requestId: join.requestId,
      displayName: "Pixel 9 · 工作",
      platform: "mobile",
      open: true,
    })
  })

  it("captures the request and keeps the nonce in memory", async () => {
    const { server, first, join } = await pending()
    const [incoming] = await listIncoming(first.context, first.device)
    const approval = await beginApproval(first.context, first.device, incoming!)
    expect(approval.request.deviceId).toBe(join.keys.deviceId)
    expect(approval.nonceA).toHaveLength(32)
    expect(server.requests.get(join.requestId)).toMatchObject({
      state: "nonce_set",
      approverDeviceId: first.device.deviceId,
    })
    expect(await pollApproval(first.context, first.device, approval)).toEqual({
      phase: "waiting-reveal",
    })
  })

  it("refuses to confirm before a code was shown", async () => {
    const { first } = await pending()
    const [incoming] = await listIncoming(first.context, first.device)
    const approval = await beginApproval(first.context, first.device, incoming!)
    await expect(confirmApproval(first.context, first.device, approval)).rejects.toMatchObject({
      code: "approval-unverified",
    })
  })

  it("adds the device with its sealed name and envelope", async () => {
    const { server, first, b, join } = await pending()
    const [incoming] = await listIncoming(first.context, first.device)
    const approval = await beginApproval(first.context, first.device, incoming!)
    await pollJoin(b, join)
    await pollApproval(first.context, first.device, approval)
    await confirmApproval(first.context, first.device, approval)
    expect(server.state()!.devices[join.keys.deviceId]?.status).toBe("active")
    expect(server.envelopes.get(join.keys.deviceId)?.epoch).toBe(1)
    expect(approval.nonceA.every((byte) => byte === 0)).toBe(true)
    expect((await first.context.vault.loadPin())!.seq).toBe(1)
  })

  it("denies, and reports what ended a request", async () => {
    const { server, first, join } = await pending()
    await denyRequest(first.context, first.device, join.requestId, "denied")
    expect(server.requests.get(join.requestId)!.state).toBe("denied")
  })
})
