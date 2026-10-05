import { toBase64Url } from "@cognia/sync-protocol"

import { beginApproval, confirmApproval, listIncoming, pollApproval } from "./approve"
import { cancelJoin, completeJoin, pollJoin, startJoin } from "./join"
import { identity, spaceWithFirstDevice, testContext, testServer } from "./test-support"

describe("joining by approval", () => {
  it("needs a space", async () => {
    await expect(startJoin(testContext(testServer(), "b"), identity("B"))).rejects.toMatchObject({
      code: "space-empty",
    })
  })

  it("posts a commitment and names sealed to every active device", async () => {
    const server = testServer()
    const { device } = await spaceWithFirstDevice(server)
    const b = testContext(server, "b")
    const join = await startJoin(b, identity("Chrome"))
    const stored = server.requests.get(join.requestId)!
    expect(stored.commit).toBe(join.commit)
    expect(stored.names.map((name) => name.recipient)).toEqual([device.deviceId])
    expect(await pollJoin(b, join)).toEqual({ phase: "waiting" })
    expect(join.revealed).toBe(false)
  })

  it("reveals only after the approver's nonce, then shows the code", async () => {
    const server = testServer()
    const first = await spaceWithFirstDevice(server)
    const b = testContext(server, "b")
    const join = await startJoin(b, identity("Chrome"))
    const [incoming] = await listIncoming(first.context, first.device)
    const approval = await beginApproval(first.context, first.device, incoming!)
    const progress = await pollJoin(b, join)
    expect(progress).toMatchObject({ phase: "code", approverDeviceId: first.device.deviceId })
    expect(server.requests.get(join.requestId)!.nonceR).toBe(toBase64Url(join.nonceR))
    const approverSide = await pollApproval(first.context, first.device, approval)
    expect(approverSide).toEqual({ phase: "code", code: (progress as { code: string }).code })
  })

  it("refuses to complete without having revealed", async () => {
    const server = testServer()
    await spaceWithFirstDevice(server)
    const b = testContext(server, "b")
    const join = await startJoin(b, identity("Chrome"))
    await expect(completeJoin(b, join)).rejects.toMatchObject({ code: "approval-unverified" })
  })

  it("completes, keeping the keys and opening its envelope", async () => {
    const server = testServer()
    const first = await spaceWithFirstDevice(server)
    const b = testContext(server, "b")
    const join = await startJoin(b, identity("Chrome"))
    const [incoming] = await listIncoming(first.context, first.device)
    const approval = await beginApproval(first.context, first.device, incoming!)
    await pollJoin(b, join)
    await pollApproval(first.context, first.device, approval)
    await confirmApproval(first.context, first.device, approval)
    expect(await pollJoin(b, join)).toEqual({ phase: "approved" })
    const registry = await completeJoin(b, join)
    expect(registry.state.devices[join.keys.deviceId]).toMatchObject({
      status: "active",
      addedBy: first.device.deviceId,
    })
    expect((await b.vault.loadKeyChain())!.get(1)).toBeDefined()
    expect(join.nonceR.every((byte) => byte === 0)).toBe(true)
  })

  it("cancels", async () => {
    const server = testServer()
    await spaceWithFirstDevice(server)
    const b = testContext(server, "b")
    const join = await startJoin(b, identity("Chrome"))
    await cancelJoin(b, join)
    expect(server.requests.get(join.requestId)!.state).toBe("cancelled")
  })
})
