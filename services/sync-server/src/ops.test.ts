import { describe, expect, it } from "vitest"

import { MAX_OPS_PER_PUSH } from "@cognia/sync-protocol"
import { ChainBuilder, makeDevice, makeRecovery } from "@cognia/sync-protocol/testing/chain"

import { sealedOps } from "../test/helpers"
import { SyncHttpError } from "./http"
import { MAX_PULL_WAIT_S, parsePullQuery, planPush } from "./ops"

const SPACE = "s".repeat(43)

async function oneDevice() {
  const device = await makeDevice()
  const chain = await ChainBuilder.genesis(SPACE, device, await makeRecovery())
  return { device, state: chain.state }
}

async function refusal(promise: Promise<unknown>): Promise<SyncHttpError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof SyncHttpError) return error
    throw error
  }
  throw new Error("expected a refusal")
}

describe("planPush", () => {
  it("accepts consecutive, signed ops of the current epoch", async () => {
    const { device, state } = await oneDevice()
    const ops = await sealedOps(SPACE, device, { from: 1, count: 3 })
    const plan = await planPush({
      state,
      spaceId: SPACE,
      deviceId: device.deviceId,
      lastDeviceSeq: 0,
      body: { ops },
    })
    expect(plan.lastDeviceSeq).toBe(3)
    expect(plan.ops.map((op) => op.deviceSeq)).toEqual([1, 2, 3])
  })

  it("acknowledges a resent prefix without storing it again", async () => {
    const { device, state } = await oneDevice()
    const ops = await sealedOps(SPACE, device, { from: 1, count: 4 })
    const plan = await planPush({
      state,
      spaceId: SPACE,
      deviceId: device.deviceId,
      lastDeviceSeq: 2,
      body: { ops },
    })
    expect(plan.ops.map((op) => op.deviceSeq)).toEqual([3, 4])
    const all = await planPush({
      state,
      spaceId: SPACE,
      deviceId: device.deviceId,
      lastDeviceSeq: 4,
      body: { ops },
    })
    expect(all).toEqual({ ops: [], lastDeviceSeq: 4 })
  })

  it("answers a gap with the sequence number it expects", async () => {
    const { device, state } = await oneDevice()
    const ops = await sealedOps(SPACE, device, { from: 5, count: 1 })
    const error = await refusal(
      planPush({
        state,
        spaceId: SPACE,
        deviceId: device.deviceId,
        lastDeviceSeq: 2,
        body: { ops },
      })
    )
    expect(error).toMatchObject({ status: 409, code: "seq_gap", details: { expected: 3 } })
  })

  it("refuses ops sealed under another epoch", async () => {
    const { device, state } = await oneDevice()
    const ops = await sealedOps(SPACE, device, { from: 1, count: 1, epoch: 2 })
    const error = await refusal(
      planPush({
        state,
        spaceId: SPACE,
        deviceId: device.deviceId,
        lastDeviceSeq: 0,
        body: { ops },
      })
    )
    expect(error).toMatchObject({ status: 409, code: "epoch_stale", details: { epoch: 1 } })
  })

  it("refuses a bad signature, another device's op and a broken sequence", async () => {
    const { device, state } = await oneDevice()
    const other = await makeDevice()
    const [op] = await sealedOps(SPACE, device, { from: 1, count: 1 })
    const forged = { ...op!, hlc: { ms: op!.hlc.ms + 1, c: 0 } }
    const args = { state, spaceId: SPACE, deviceId: device.deviceId, lastDeviceSeq: 0 }
    expect(await refusal(planPush({ ...args, body: { ops: [forged] } }))).toMatchObject({
      status: 400,
      message: expect.stringContaining("bad signature"),
    })
    const foreign = await sealedOps(SPACE, other, { from: 1, count: 1 })
    expect((await refusal(planPush({ ...args, body: { ops: foreign } }))).status).toBe(400)
    const two = await sealedOps(SPACE, device, { from: 1, count: 3 })
    expect((await refusal(planPush({ ...args, body: { ops: [two[0], two[2]] } }))).status).toBe(400)
  })

  it.each([
    ["no ops key", {}],
    ["an extra key", { ops: [], extra: 1 }],
    ["an empty push", { ops: [] }],
    ["too many ops", { ops: Array.from({ length: MAX_OPS_PER_PUSH + 1 }, () => ({})) }],
    ["a malformed op", { ops: [{ deviceSeq: 1 }] }],
  ])("refuses %s", async (_label, body) => {
    const { device, state } = await oneDevice()
    const error = await refusal(
      planPush({ state, spaceId: SPACE, deviceId: device.deviceId, lastDeviceSeq: 0, body })
    )
    expect(error.status).toBe(400)
  })
})

describe("parsePullQuery", () => {
  it("defaults and bounds after and wait", () => {
    expect(parsePullQuery(null, null)).toEqual({ after: 0, waitS: 0 })
    expect(parsePullQuery("12", String(MAX_PULL_WAIT_S))).toEqual({
      after: 12,
      waitS: MAX_PULL_WAIT_S,
    })
  })

  it.each([
    ["-1", null],
    ["1.5", null],
    ["01", null],
    ["1", "26"],
    ["1", "-1"],
    ["1", "x"],
  ])("refuses after=%s wait=%s", (after, wait) => {
    expect(() => parsePullQuery(after, wait)).toThrow(SyncHttpError)
  })
})
