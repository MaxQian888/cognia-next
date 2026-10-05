import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"

import {
  DEVICE_PROOF_HEADER,
  bodyDigest,
  createDeviceProof,
  foldRegistry,
  matchesSasCommit,
  randomBytes,
  fromBase64Url,
  toBase64Url,
  transcriptHash,
  utf8,
} from "@cognia/sync-protocol"
import {
  ChainBuilder,
  deviceSigner,
  makeDevice,
  makeRecovery,
  signWith,
} from "@cognia/sync-protocol/testing/chain"

import {
  Person,
  enrollBody,
  fakeEnvelope,
  fakeEnvelopes,
  requestToJoin,
  approve,
  spaceWithGenesis,
  testEnv,
  transcriptFor,
  twoDevices,
  upToReveal,
  type PendingDevice,
} from "../test/helpers"
import { handleRequest } from "./index"
import type { SyncSpace } from "./space"

function stubFor(spaceId: string): DurableObjectStub<SyncSpace> {
  return testEnv.SYNC_SPACE.get(testEnv.SYNC_SPACE.idFromName(spaceId))
}

describe("the space", () => {
  it("starts empty", async () => {
    const person = new Person()
    expect(await person.json("GET", "/v1/space")).toEqual({
      status: 200,
      body: { state: "empty", protocolVersion: 1 },
    })
    expect((await person.json("GET", "/v1/envelopes/recovery")).body.error).toBe("space_empty")
  })

  it("accepts genesis once, and answers with the head", async () => {
    const { person, chain } = await spaceWithGenesis()
    expect(await person.json("GET", "/v1/space")).toEqual({
      status: 200,
      body: {
        state: "ready",
        genesisHash: chain.state.genesisHash,
        head: chain.state.head,
        epoch: 1,
        protocolVersion: 1,
      },
    })
    const again = await person.json("POST", "/v1/space/genesis", {
      body: { entry: chain.entries[0], envelopes: fakeEnvelopes(chain.state) },
    })
    expect(again).toMatchObject({ status: 409, body: { error: "space_exists" } })
  })

  it("lets exactly one of two racing first devices win", async () => {
    const person = new Person()
    const spaceId = await person.spaceId()
    const chains = await Promise.all(
      [0, 1].map(async () =>
        ChainBuilder.genesis(spaceId, await makeDevice(), await makeRecovery())
      )
    )
    const results = await Promise.all(
      chains.map((chain) =>
        person.json("POST", "/v1/space/genesis", {
          body: { entry: chain.entries[0], envelopes: fakeEnvelopes(chain.state) },
        })
      )
    )
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
  })

  it("refuses a genesis that is invalid or lacks the recovery envelope", async () => {
    const person = new Person()
    const chain = await ChainBuilder.genesis(
      await person.spaceId(),
      await makeDevice(),
      await makeRecovery()
    )
    const missing = await person.json("POST", "/v1/space/genesis", {
      body: { entry: chain.entries[0], envelopes: fakeEnvelopes(chain.state).slice(0, 1) },
    })
    expect(missing).toMatchObject({ status: 400, body: { error: "envelopes_incomplete" } })
    const other = await ChainBuilder.genesis(
      "t".repeat(43),
      await makeDevice(),
      await makeRecovery()
    )
    const foreign = await person.json("POST", "/v1/space/genesis", {
      body: { entry: other.entries[0], envelopes: fakeEnvelopes(other.state) },
    })
    expect(foreign).toMatchObject({ status: 400, body: { error: "invalid_entry" } })
    expect((await person.json("GET", "/v1/space")).body.state).toBe("empty")
  })

  it("serves the registry in pages a client can fold", async () => {
    const space = await spaceWithGenesis()
    await space.chain.rotateEpoch(space.first)
    const rotate = await space.person.json("POST", "/v1/registry", {
      body: { entries: [space.chain.entries[1]], envelopes: fakeEnvelopes(space.chain.state) },
      device: space.first,
    })
    expect(rotate.status).toBe(200)
    const all = await space.person.json("GET", "/v1/registry")
    expect(all.body.entries).toHaveLength(2)
    expect(all.body.more).toBe(false)
    const folded = await foldRegistry(all.body.entries, { spaceId: space.chain.spaceId })
    expect(folded!.state).toEqual(space.chain.state)
    const tail = await space.person.json("GET", "/v1/registry?after=0")
    expect(tail.body.entries).toHaveLength(1)
    expect((await space.person.json("GET", "/v1/registry?after=x")).status).toBe(400)
    expect((await space.person.json("GET", "/v1/registry?after=-2")).status).toBe(400)
  })

  it("hands the recovery envelope to the person and the device envelope to the device", async () => {
    const space = await spaceWithGenesis()
    expect((await space.person.json("GET", "/v1/envelopes/recovery")).body.envelope.recipient).toBe(
      "recovery"
    )
    const self = await space.person.json("GET", "/v1/envelopes/self", { device: space.first })
    expect(self.body.envelope.recipient).toBe(space.first.deviceId)
    expect((await space.person.json("GET", "/v1/envelopes/self")).body.error).toBe("bad_proof")
  })
})

describe("approval by an existing device", () => {
  it("runs commit, nonce, reveal and append end to end", async () => {
    const space = await spaceWithGenesis()
    const pending = await requestToJoin(space, "Chrome", "web")

    const list = await space.person.json("GET", "/v1/enroll/requests", { device: space.first })
    expect(list.body.requests).toHaveLength(1)
    expect(list.body.requests[0]).toMatchObject({
      requestId: pending.requestId,
      deviceId: pending.device.deviceId,
      commit: pending.commit,
      state: "pending",
      open: true,
      name: { recipient: space.first.deviceId },
      nonceR: null,
    })

    const nonceA = await upToReveal(space, pending)
    const seen = await space.person.json("GET", `/v1/enroll/requests/${pending.requestId}`, {
      device: pending.device,
    })
    expect(seen.body).toMatchObject({
      state: "revealed",
      approverDeviceId: space.first.deviceId,
      nonceA: toBase64Url(nonceA),
    })

    // The approver gets the revealed nonce and can check it against the commitment itself.
    const approverView = await space.person.json("GET", "/v1/enroll/requests", {
      device: space.first,
    })
    const nonceR = approverView.body.requests[0].nonceR as string
    expect(await matchesSasCommit(fromBase64Url(nonceR), pending.commit)).toBe(true)

    const appended = await approve(space, pending)
    expect(appended).toEqual({ status: 200, body: { head: space.chain.state.head, epoch: 1 } })

    const done = await space.person.json("GET", `/v1/enroll/requests/${pending.requestId}`, {
      device: pending.device,
    })
    expect(done.body).toMatchObject({ state: "approved", entrySeq: 1 })
    const envelope = await space.person.json("GET", "/v1/envelopes/self", {
      device: pending.device,
    })
    expect(envelope.body.envelope.recipient).toBe(pending.device.deviceId)
  })

  it("never shows the approver's nonce to other devices, nor the revealed nonce to them", async () => {
    const space = await spaceWithGenesis()
    const second = await requestToJoin(space, "Second")
    await upToReveal(space, second)
    await approve(space, second)
    const pending = await requestToJoin(space, "Third")
    await upToReveal(space, pending)
    const view = await space.person.json("GET", "/v1/enroll/requests", { device: second.device })
    const row = view.body.requests.find(
      (r: { requestId: string }) => r.requestId === pending.requestId
    )
    expect(row.nonceR).toBeNull()
    expect(row).not.toHaveProperty("nonceA")
  })

  it("refuses a reveal that does not match the commitment, and keeps the request", async () => {
    const space = await spaceWithGenesis()
    const pending = await requestToJoin(space)
    await space.person.json("POST", `/v1/enroll/requests/${pending.requestId}/nonce`, {
      body: { nonceA: toBase64Url(randomBytes(32)) },
      device: space.first,
    })
    const bad = await space.person.json("POST", `/v1/enroll/requests/${pending.requestId}/reveal`, {
      body: { nonceR: toBase64Url(randomBytes(32)) },
      device: pending.device,
    })
    expect(bad).toMatchObject({ status: 400, body: { error: "bad_request" } })
    const state = await space.person.json("GET", `/v1/enroll/requests/${pending.requestId}`, {
      device: pending.device,
    })
    expect(state.body.state).toBe("nonce_set")
  })

  it("refuses a reveal before the approver's nonce, and a second nonce", async () => {
    const space = await spaceWithGenesis()
    const pending = await requestToJoin(space)
    const early = await space.person.json(
      "POST",
      `/v1/enroll/requests/${pending.requestId}/reveal`,
      {
        body: { nonceR: toBase64Url(pending.nonceR) },
        device: pending.device,
      }
    )
    expect(early).toMatchObject({ status: 409, body: { error: "request_state" } })
    await upToReveal(space, pending)
    const again = await space.person.json(
      "POST",
      `/v1/enroll/requests/${pending.requestId}/nonce`,
      {
        body: { nonceA: toBase64Url(randomBytes(32)) },
        device: space.first,
      }
    )
    expect(again.body.error).toBe("request_state")
  })

  it("refuses an approval whose transcript or device differs from the request", async () => {
    const space = await spaceWithGenesis()
    const pending = await requestToJoin(space)
    await upToReveal(space, pending)
    const base = space.chain.fork()
    const wrongTranscript = await base.addByApproval(space.first, pending.device, {
      requestId: pending.requestId,
      transcriptHash: toBase64Url(new Uint8Array(32).fill(1)),
    })
    const envelopes = [
      fakeEnvelope(1, { recipient: pending.device.deviceId, encPub: pending.device.encPub }),
    ]
    const first = await space.person.json("POST", "/v1/registry", {
      body: { entries: [wrongTranscript], envelopes },
      device: space.first,
    })
    expect(first).toMatchObject({ status: 400, body: { error: "invalid_entry" } })

    const impostor = await makeDevice("Impostor", pending.device.platform)
    const swapped = await space.chain.fork().addByApproval(space.first, impostor, {
      requestId: pending.requestId,
      transcriptHash: await transcriptHash(transcriptFor(space, pending, space.first.deviceId)),
    })
    const second = await space.person.json("POST", "/v1/registry", {
      body: {
        entries: [swapped],
        envelopes: [fakeEnvelope(1, { recipient: impostor.deviceId, encPub: impostor.encPub })],
      },
      device: space.first,
    })
    expect(second).toMatchObject({ status: 400, body: { error: "invalid_entry" } })
    expect((await space.person.json("GET", "/v1/space")).body.head.seq).toBe(0)
  })

  it("refuses an approval of a request that was not revealed", async () => {
    const space = await spaceWithGenesis()
    const pending = await requestToJoin(space)
    const response = await approve(space, pending)
    expect(response).toMatchObject({ status: 409, body: { error: "request_state" } })
  })

  it("lets only the approver finish, and needs the new device's envelope", async () => {
    const space = await spaceWithGenesis()
    const second = await requestToJoin(space, "Second")
    await upToReveal(space, second)
    await approve(space, second)

    const pending = await requestToJoin(space, "Third")
    await upToReveal(space, pending)
    const transcript = await transcriptHash(transcriptFor(space, pending, space.first.deviceId))
    const bySecond = await space.chain.fork().addByApproval(second.device, pending.device, {
      requestId: pending.requestId,
      transcriptHash: transcript,
    })
    const envelopes = [
      fakeEnvelope(1, { recipient: pending.device.deviceId, encPub: pending.device.encPub }),
    ]
    const other = await space.person.json("POST", "/v1/registry", {
      body: { entries: [bySecond], envelopes },
      device: second.device,
    })
    expect(other).toMatchObject({ status: 409, body: { error: "request_state" } })

    const byFirst = await space.chain.fork().addByApproval(space.first, pending.device, {
      requestId: pending.requestId,
      transcriptHash: transcript,
    })
    const noEnvelope = await space.person.json("POST", "/v1/registry", {
      body: { entries: [byFirst], envelopes: [] },
      device: space.first,
    })
    expect(noEnvelope).toMatchObject({ status: 400, body: { error: "envelopes_incomplete" } })
  })

  it("denies, reports a mismatch and cancels without touching the registry", async () => {
    const space = await spaceWithGenesis()
    const denied = await requestToJoin(space)
    expect(
      (
        await space.person.json("POST", `/v1/enroll/requests/${denied.requestId}/deny`, {
          body: { reason: "denied" },
          device: space.first,
        })
      ).body
    ).toEqual({ state: "denied" })

    const mismatch = await requestToJoin(space)
    expect(
      (
        await space.person.json("POST", `/v1/enroll/requests/${mismatch.requestId}/deny`, {
          body: { reason: "mismatch" },
          device: space.first,
        })
      ).body.error
    ).toBe("request_state")
    await upToReveal(space, mismatch)
    expect(
      (
        await space.person.json("POST", `/v1/enroll/requests/${mismatch.requestId}/deny`, {
          body: { reason: "mismatch" },
          device: space.first,
        })
      ).body
    ).toEqual({ state: "mismatch" })

    const cancelled = await requestToJoin(space)
    expect(
      (
        await space.person.json("DELETE", `/v1/enroll/requests/${cancelled.requestId}`, {
          device: cancelled.device,
        })
      ).body
    ).toEqual({
      state: "cancelled",
    })
    expect(
      (
        await space.person.json("DELETE", `/v1/enroll/requests/${cancelled.requestId}`, {
          device: cancelled.device,
        })
      ).body.error
    ).toBe("request_state")
    const finished = await space.person.json("GET", "/v1/enroll/requests", { device: space.first })
    expect(finished.body.requests.map((r: { state: string }) => r.state).sort()).toEqual([
      "cancelled",
      "denied",
      "mismatch",
    ])
    expect((await space.person.json("GET", "/v1/space")).body.head.seq).toBe(0)
  })

  it("lets only the request's own device poll or cancel it", async () => {
    const space = await spaceWithGenesis()
    const pending = await requestToJoin(space)
    const stranger = await makeDevice()
    expect(
      (
        await space.person.json("GET", `/v1/enroll/requests/${pending.requestId}`, {
          device: stranger,
        })
      ).body.error
    ).toBe("device_unknown")
    expect(
      (
        await space.person.json("GET", `/v1/enroll/requests/req_${"0".repeat(26)}`, {
          device: stranger,
        })
      ).body.error
    ).toBe("request_unknown")
    expect(
      (await space.person.json("GET", "/v1/enroll/requests", { device: pending.device })).body.error
    ).toBe("device_unknown")
  })

  it("validates a new request strictly", async () => {
    const space = await spaceWithGenesis()
    const device = await makeDevice()
    const body = await enrollBody(device, space.chain.state, toBase64Url(new Uint8Array(32)))
    const post = (value: unknown) =>
      space.person.json("POST", "/v1/enroll/requests", { body: value })
    expect((await post({ ...body, pop: toBase64Url(new Uint8Array(64)) })).body.error).toBe(
      "bad_proof"
    )
    expect((await post({ ...body, extra: 1 })).body.error).toBe("bad_request")
    expect((await post({ ...body, names: [] })).body.error).toBe("bad_request")
    expect(
      (
        await post(
          await enrollBody(
            { ...device, platform: "headless" as never },
            space.chain.state,
            body.commit
          )
        )
      ).body.error
    ).toBe("bad_request")
    expect(
      (
        await post(
          await enrollBody(
            { ...device, signPub: space.first.signPub, sign: space.first.sign },
            space.chain.state,
            body.commit
          )
        )
      ).body.error
    ).toBe("bad_request")
    expect(
      (await post(await enrollBody({ ...space.first }, space.chain.state, body.commit))).body.error
    ).toBe("bad_request")
    expect((await post(body)).status).toBe(201)
    expect((await post(body)).body.error).toBe("request_state")
  })

  it("caps waiting devices at three and requests at ten an hour", async () => {
    const space = await spaceWithGenesis()
    const requests: PendingDevice[] = []
    for (let i = 0; i < 3; i++) requests.push(await requestToJoin(space))
    await expect(requestToJoin(space)).rejects.toThrow(/too_many_requests/)
    for (const pending of requests) {
      await space.person.json("DELETE", `/v1/enroll/requests/${pending.requestId}`, {
        device: pending.device,
      })
    }
    for (let i = 0; i < 7; i++) {
      const pending = await requestToJoin(space)
      await space.person.json("DELETE", `/v1/enroll/requests/${pending.requestId}`, {
        device: pending.device,
      })
    }
    await expect(requestToJoin(space)).rejects.toThrow(/at most 10 requests an hour/)
  })

  it("expires requests after fifteen minutes and cleans them up an hour later", async () => {
    const space = await spaceWithGenesis()
    const pending = await requestToJoin(space)
    const stub = stubFor(space.chain.spaceId)
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE requests SET expires_at = ? WHERE request_id = ?",
        Date.now() - 1,
        pending.requestId
      )
      await state.storage.setAlarm(Date.now() + 60_000)
    })
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const expired = await space.person.json("GET", `/v1/enroll/requests/${pending.requestId}`, {
      device: pending.device,
    })
    expect(expired.body.state).toBe("expired")
    const nonce = await space.person.json(
      "POST",
      `/v1/enroll/requests/${pending.requestId}/nonce`,
      {
        body: { nonceA: toBase64Url(randomBytes(32)) },
        device: space.first,
      }
    )
    expect(nonce).toMatchObject({ status: 410, body: { error: "request_expired" } })

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE requests SET finished_at = ?", Date.now() - 61 * 60 * 1000)
      await state.storage.setAlarm(Date.now() + 60_000)
    })
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(
      (
        await space.person.json("GET", `/v1/enroll/requests/${pending.requestId}`, {
          device: pending.device,
        })
      ).body.error
    ).toBe("request_unknown")
  })
})

describe("recovery", () => {
  it("accepts the add and its rotation as one batch", async () => {
    const space = await spaceWithGenesis()
    const phone = await makeDevice("Phone", "mobile")
    const [add, rotate] = await space.chain.addByRecovery(space.recovery, phone)
    const response = await space.person.json("POST", "/v1/registry", {
      body: { entries: [add, rotate], envelopes: fakeEnvelopes(space.chain.state) },
      device: phone,
    })
    expect(response).toEqual({ status: 200, body: { head: space.chain.state.head, epoch: 2 } })
    expect(
      (await space.person.json("GET", "/v1/envelopes/self", { device: phone })).body.envelope.epoch
    ).toBe(2)
  })

  it("refuses the add alone, and leaves nothing behind", async () => {
    const space = await spaceWithGenesis()
    const phone = await makeDevice("Phone", "mobile")
    const [add] = await space.chain.fork().addByRecovery(space.recovery, phone)
    const response = await space.person.json("POST", "/v1/registry", {
      body: { entries: [add], envelopes: [] },
      device: phone,
    })
    expect(response).toMatchObject({ status: 400, body: { error: "invalid_entry" } })
    expect((await space.person.json("GET", "/v1/space")).body.head.seq).toBe(0)
  })

  it("refuses a batch whose proof comes from a device that did not sign", async () => {
    const space = await spaceWithGenesis()
    const phone = await makeDevice("Phone", "mobile")
    const fork = space.chain.fork()
    const [add, rotate] = await fork.addByRecovery(space.recovery, phone)
    const response = await space.person.json("POST", "/v1/registry", {
      body: { entries: [add, rotate], envelopes: fakeEnvelopes(fork.state) },
      device: space.first,
    })
    expect(response).toMatchObject({ status: 403, body: { error: "bad_proof" } })
  })
})

describe("revocation", () => {
  it("needs envelopes for every remaining device and recovery", async () => {
    const { space, second } = await twoDevices()
    const fork = space.chain.fork()
    const revoke = await fork.revoke(space.first, second.device.deviceId)
    const partial = await space.person.json("POST", "/v1/registry", {
      body: { entries: [revoke], envelopes: fakeEnvelopes(fork.state).slice(1) },
      device: space.first,
    })
    expect(partial).toMatchObject({ status: 400, body: { error: "envelopes_incomplete" } })
    const withRevoked = await space.person.json("POST", "/v1/registry", {
      body: {
        entries: [revoke],
        envelopes: [
          ...fakeEnvelopes(fork.state),
          fakeEnvelope(fork.epoch, {
            recipient: second.device.deviceId,
            encPub: second.device.encPub,
          }),
        ],
      },
      device: space.first,
    })
    expect(withRevoked.body.error).toBe("envelopes_incomplete")
    expect((await space.person.json("GET", "/v1/space")).body.epoch).toBe(1)
  })

  it("revokes, drops the device's envelope and refuses the device from then on", async () => {
    const { space, second } = await twoDevices()
    const revoke = await space.chain.revoke(space.first, second.device.deviceId)
    const response = await space.person.json("POST", "/v1/registry", {
      body: { entries: [revoke], envelopes: fakeEnvelopes(space.chain.state) },
      device: space.first,
    })
    expect(response).toMatchObject({ status: 200, body: { epoch: 2 } })

    const refused = await space.person.json("GET", "/v1/envelopes/self", { device: second.device })
    expect(refused).toMatchObject({ status: 403, body: { error: "device_revoked" } })
    expect(
      (await space.person.json("GET", "/v1/enroll/requests", { device: second.device })).status
    ).toBe(403)

    // It can still read the signed device list and find its own revocation.
    const registry = await space.person.json("GET", "/v1/registry")
    const folded = await foldRegistry(registry.body.entries, { spaceId: space.chain.spaceId })
    expect(folded!.state.devices[second.device.deviceId]!.status).toBe("revoked")

    await runInDurableObject(stubFor(space.chain.spaceId), async (_instance, state) => {
      const recipients = state.storage.sql
        .exec<{ recipient: string }>("SELECT recipient FROM envelopes")
        .toArray()
      expect(recipients.map((r) => r.recipient).sort()).toEqual(
        [space.first.deviceId, "recovery"].sort()
      )
    })
  })

  it("refuses a revoked device's forged proof attempt as unknown when its key does not sign", async () => {
    const { space, second } = await twoDevices()
    const forged = { deviceId: second.device.deviceId, sign: (await makeDevice()).sign }
    const response = await space.person.json("GET", "/v1/envelopes/self", { device: forged })
    expect(response).toMatchObject({ status: 401, body: { error: "bad_proof" } })
  })
})

describe("appends", () => {
  it("answers head_moved for an entry built on an old head", async () => {
    const space = await spaceWithGenesis()
    const stale = space.chain.fork()
    await space.chain.rotateEpoch(space.first)
    await space.person.json("POST", "/v1/registry", {
      body: { entries: [space.chain.entries[1]], envelopes: fakeEnvelopes(space.chain.state) },
      device: space.first,
    })
    const late = await stale.rotateEpoch(space.first)
    const response = await space.person.json("POST", "/v1/registry", {
      body: { entries: [late], envelopes: fakeEnvelopes(stale.state) },
      device: space.first,
    })
    expect(response).toMatchObject({ status: 409, body: { error: "head_moved" } })
  })

  it("refuses two entries unless they are a recovery batch", async () => {
    const space = await spaceWithGenesis()
    const fork = space.chain.fork()
    const a = await fork.rotateEpoch(space.first)
    const b = await fork.rotateEpoch(space.first)
    const response = await space.person.json("POST", "/v1/registry", {
      body: { entries: [a, b], envelopes: fakeEnvelopes(fork.state) },
      device: space.first,
    })
    expect(response).toMatchObject({ status: 400, body: { error: "invalid_entry" } })
  })

  it("refuses a proof from too far in the past or future", async () => {
    const space = await spaceWithGenesis()
    const late = await space.person.json("GET", "/v1/envelopes/self", {
      device: space.first,
      iat: Date.now() - 10 * 60 * 1000,
    })
    expect(late).toMatchObject({ status: 401, body: { error: "clock_skew" } })
    const early = await space.person.json("GET", "/v1/envelopes/self", {
      device: space.first,
      iat: Date.now() + 10 * 60 * 1000,
    })
    expect(early.body.error).toBe("clock_skew")
  })

  it("refuses a proof made for another request", async () => {
    const space = await spaceWithGenesis()
    const signed = await signWith(
      { ...space.chain.base(), type: "epoch-rotate", epoch: await space.chain.nextEpochBlock() },
      [deviceSigner(space.first)]
    )
    const body = JSON.stringify({ entries: [signed], envelopes: [] })
    // A valid proof reaches validation (and fails on the missing envelopes)…
    const genuine = await space.person.json("POST", "/v1/registry", { body, device: space.first })
    expect(genuine.body.error).toBe("envelopes_incomplete")
    // …a proof signed for a GET of another path does not.
    const headers = new Headers({ authorization: `Bearer ${await space.person.token()}` })
    headers.set(
      DEVICE_PROOF_HEADER,
      await createDeviceProof(
        {
          v: 1,
          spaceId: space.chain.spaceId,
          deviceId: space.first.deviceId,
          method: "GET",
          path: "/v1/envelopes/self",
          bodySha256: await bodyDigest(utf8("")),
          iat: Date.now(),
        },
        space.first.sign.privateKey
      )
    )
    const replayed = await handleRequest(
      new Request("https://sync.test/v1/registry", { method: "POST", headers, body }),
      testEnv
    )
    expect(replayed.status).toBe(401)
    expect(((await replayed.json()) as { error: string }).error).toBe("bad_proof")
  })
})

describe("spaces are separate", () => {
  it("never shows one person's space to another", async () => {
    const space = await spaceWithGenesis()
    const other = new Person()
    expect((await other.json("GET", "/v1/space")).body.state).toBe("empty")
    expect(
      (await other.json("GET", "/v1/envelopes/self", { device: space.first })).body.error
    ).toBe("space_empty")
  })
})
