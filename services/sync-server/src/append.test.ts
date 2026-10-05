import { describe, expect, it } from "vitest"

import { ChainBuilder, makeDevice, makeRecovery } from "@cognia/sync-protocol/testing/chain"

import { fakeEnvelope, fakeEnvelopes } from "../test/helpers"
import { planAppend } from "./append"

const SPACE = "s".repeat(43)

async function refusal(promise: Promise<unknown>) {
  return promise.then(
    () => null,
    (caught: unknown) => caught as { status: number; code: string; message: string }
  )
}

describe("planAppend", () => {
  it("plans a rotation with a full replacement envelope set", async () => {
    const first = await makeDevice()
    const chain = await ChainBuilder.genesis(SPACE, first, await makeRecovery())
    const before = chain.state
    const rotate = await chain.rotateEpoch(first)
    const plan = await planAppend(before, {
      entries: [rotate],
      envelopes: fakeEnvelopes(chain.state),
    })
    expect(plan.state).toEqual(chain.state)
    expect(plan.envelopes.mode).toBe("replace")
    expect(plan.envelopes.list).toHaveLength(2)
    expect(plan.deviceSigners).toEqual([first.deviceId])
    expect(plan.approval).toBeNull()
  })

  it("plans an approval with one added envelope", async () => {
    const first = await makeDevice()
    const chain = await ChainBuilder.genesis(SPACE, first, await makeRecovery())
    const before = chain.state
    const second = await makeDevice()
    const add = await chain.addByApproval(first, second)
    const plan = await planAppend(before, {
      entries: [add],
      envelopes: [fakeEnvelope(1, { recipient: second.deviceId, encPub: second.encPub })],
    })
    expect(plan.envelopes.mode).toBe("add")
    expect(plan.approval?.device.deviceId).toBe(second.deviceId)
  })

  it("refuses malformed bodies", async () => {
    const first = await makeDevice()
    const chain = await ChainBuilder.genesis(SPACE, first, await makeRecovery())
    for (const body of [
      null,
      [],
      { entries: [] },
      { entries: [1, 2, 3], envelopes: [] },
      { entries: [{}], envelopes: {} },
      { entries: [{}], envelopes: [], x: 1 },
    ]) {
      expect(await refusal(planAppend(chain.state, body))).toMatchObject({
        status: 400,
        code: "bad_request",
      })
    }
    expect(await refusal(planAppend(chain.state, { entries: [{}], envelopes: [] }))).toMatchObject({
      code: "invalid_entry",
    })
  })

  it("maps a stale entry to head_moved", async () => {
    const first = await makeDevice()
    const chain = await ChainBuilder.genesis(SPACE, first, await makeRecovery())
    const stale = chain.fork()
    await chain.rotateEpoch(first)
    const late = await stale.rotateEpoch(first)
    expect(
      await refusal(planAppend(chain.state, { entries: [late], envelopes: [] }))
    ).toMatchObject({ status: 409, code: "head_moved" })
  })
})
