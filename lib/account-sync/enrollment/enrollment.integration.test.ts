/**
 * Three devices of one person against an in-memory sync server, through
 * every phase-2 flow, and a server that lies in each way the protocol
 * defends against.
 */

import { RECOVERY_SIGNER, newEpochKey, type DevicePlatform } from "@cognia/sync-protocol"

import {
  generateDeviceKeyMaterial,
  importDeviceKeys,
  sealEpochEnvelope,
  type DeviceKeys,
} from "../crypto"
import { RegistryIntegrityError, currentKeyChain, verifyRegistry } from "../registry-sync"
import { createFakeSyncServer, type FakeSyncServer } from "../testing/fake-sync-server"
import { createMemoryKeyring } from "../testing/memory-keyring"
import { __clearAccountSyncKeyCache, createAccountSyncVault } from "../vault-store"
import { beginApproval, confirmApproval, denyRequest, listIncoming, pollApproval } from "./approve"
import { createAccountSyncContext, type AccountSyncContext } from "./context"
import { commitFirstDevice, prepareFirstDevice } from "./first-device"
import { registryFingerprint } from "./fingerprint"
import { cancelJoin, completeJoin, pollJoin, startJoin, type JoinRequest } from "./join"
import { commitRecoveryKey, prepareRecoveryKey, revokeDevice, rotateKeys } from "./manage"
import { recoverWithKey } from "./recover"
import { handleRevokedAnswer } from "./revoked"
import { readEnrollmentStatus } from "./status"

const SPACE = "s".repeat(43)

type Rewrite = (path: string, response: Response, request: Request) => Promise<Response> | Response

interface Device {
  context: AccountSyncContext
  rewrite: { current: Rewrite | null }
  keys(): Promise<DeviceKeys>
}

function deviceOn(server: FakeSyncServer, name: string): Device {
  const rewrite: Device["rewrite"] = { current: null }
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const response = await server.fetch(request.clone())
    return rewrite.current
      ? rewrite.current(new URL(request.url).pathname, response, request)
      : response
  }) as typeof fetch
  const context = createAccountSyncContext(
    {
      localAccountId: `local_${name}`,
      issuer: "https://id.test/api/auth",
      userId: "usr_person",
      spaceId: SPACE,
      syncUrl: "https://sync.test",
      accessToken: async () => "token",
    },
    {
      fetchImpl,
      vault: createAccountSyncVault(
        { localAccountId: `local_${name}`, spaceId: SPACE },
        createMemoryKeyring()
      ),
    }
  )
  return {
    context,
    rewrite,
    async keys() {
      const keys = await context.vault.loadDeviceKeys()
      if (!keys) throw new Error(`${name} has no keys`)
      return keys
    },
  }
}

const input = (name: string, platform: DevicePlatform) => ({ name, platform })

async function createSpace(server: FakeSyncServer, name = "a") {
  const a = deviceOn(server, name)
  const prepared = await prepareFirstDevice(a.context, input("MacBook", "desktop"))
  const recoveryKeyText = prepared.recoveryKeyText
  expect(await commitFirstDevice(a.context, prepared)).toMatchObject({ kind: "created" })
  return { a, recoveryKeyText }
}

/** Runs the approval of `joiner` by `approver` up to both codes. */
async function codes(approver: Device, joiner: Device, join: JoinRequest) {
  const approverKeys = await approver.keys()
  const [incoming] = (await listIncoming(approver.context, approverKeys)).filter(
    (r) => r.requestId === join.requestId
  )
  const approval = await beginApproval(approver.context, approverKeys, incoming!)
  const joinerView = await pollJoin(joiner.context, join)
  const approverView = await pollApproval(approver.context, approverKeys, approval)
  return { approval, approverKeys, incoming: incoming!, joinerView, approverView }
}

async function joinByApproval(
  approver: Device,
  joiner: Device,
  name: string,
  platform: DevicePlatform
) {
  const join = await startJoin(joiner.context, input(name, platform))
  const { approval, approverKeys, joinerView, approverView, incoming } = await codes(
    approver,
    joiner,
    join
  )
  expect(joinerView.phase).toBe("code")
  expect(approverView.phase).toBe("code")
  expect((joinerView as { code: string }).code).toBe((approverView as { code: string }).code)
  expect(incoming.displayName).toBe(name)
  await confirmApproval(approver.context, approverKeys, approval)
  expect(await pollJoin(joiner.context, join)).toEqual({ phase: "approved" })
  await completeJoin(joiner.context, join)
}

beforeEach(() => __clearAccountSyncKeyCache())

describe("three devices of one person", () => {
  it("create, approve, recover, regenerate, revoke and rotate", async () => {
    const server = createFakeSyncServer({ spaceId: SPACE })
    const { a, recoveryKeyText } = await createSpace(server)

    // B joins by approval.
    const b = deviceOn(server, "b")
    expect((await readEnrollmentStatus(b.context)).kind).toBe("not-enrolled")
    await joinByApproval(a, b, "Chrome", "web")
    const [statusA, statusB] = await Promise.all([
      readEnrollmentStatus(a.context),
      readEnrollmentStatus(b.context),
    ])
    expect(statusA.kind).toBe("enrolled")
    expect(statusB.kind).toBe("enrolled")
    if (statusA.kind !== "enrolled" || statusB.kind !== "enrolled") throw new Error("unreachable")
    expect(registryFingerprint(statusA.registry.state)).toBe(
      registryFingerprint(statusB.registry.state)
    )
    expect(Object.keys(statusB.registry.state.devices)).toHaveLength(2)

    // C joins with the recovery key: epoch 2, and A and B can open it.
    const c = deviceOn(server, "c")
    const recovered = await recoverWithKey(
      c.context,
      recoveryKeyText.toLowerCase(),
      input("Pixel", "mobile")
    )
    expect(recovered.state.epoch).toBe(2)
    for (const device of [a, b]) {
      const status = await readEnrollmentStatus(device.context)
      if (status.kind !== "enrolled") throw new Error("not enrolled")
      const chain = await currentKeyChain(
        device.context.api,
        device.context.vault,
        status.registry.state,
        status.device
      )
      expect([...chain.keys()].sort()).toEqual([1, 2])
    }

    // A replaces the recovery key: epoch 3, and the old key no longer works.
    const prepared = await prepareRecoveryKey(a.context)
    await commitRecoveryKey(a.context, await a.keys(), prepared)
    const d = deviceOn(server, "d")
    await expect(
      recoverWithKey(d.context, recoveryKeyText, input("Old key", "web"))
    ).rejects.toMatchObject({
      code: "recovery_mismatch",
    })
    expect(server.envelopes.get(RECOVERY_SIGNER)?.recipientEncPub).toBe(prepared.keys.encPub)

    // A removes B: epoch 4, no envelope for B, and B forgets its keys on proof.
    const bKeys = await b.keys()
    const afterRevoke = await revokeDevice(a.context, await a.keys(), bKeys.deviceId)
    expect(afterRevoke.epoch).toBe(4)
    expect(server.envelopes.has(bKeys.deviceId)).toBe(false)
    await expect(b.context.api.selfEnvelope(bKeys)).rejects.toMatchObject({
      code: "device_revoked",
    })
    const removal = await handleRevokedAnswer(b.context, bKeys)
    expect(removal).toMatchObject({ seq: afterRevoke.head.seq, by: (await a.keys()).deviceId })
    expect(await b.context.vault.loadDeviceKeys()).toBeNull()
    expect(await b.context.vault.loadPin()).not.toBeNull()
    expect((await readEnrollmentStatus(b.context)).kind).toBe("removed")

    // C rotates on demand: epoch 5.
    expect((await rotateKeys(c.context, await c.keys())).epoch).toBe(5)
    const final = await verifyRegistry(a.context.api, a.context.vault)
    expect(final!.state.epoch).toBe(5)
  })

  it("lets the first device that loses the genesis race join instead", async () => {
    const server = createFakeSyncServer({ spaceId: SPACE })
    const a = deviceOn(server, "a")
    const b = deviceOn(server, "b")
    const [pa, pb] = await Promise.all([
      prepareFirstDevice(a.context, input("A", "desktop")),
      prepareFirstDevice(b.context, input("B", "web")),
    ])
    expect(await commitFirstDevice(a.context, pa)).toMatchObject({ kind: "created" })
    expect(await commitFirstDevice(b.context, pb)).toEqual({ kind: "space-exists" })
    expect(await b.context.vault.loadDeviceKeys()).toBeNull()
  })

  it("adopts a genesis whose answer was lost", async () => {
    const server = createFakeSyncServer({ spaceId: SPACE })
    const a = deviceOn(server, "a")
    a.rewrite.current = (path, response) => {
      if (path === "/v1/space/genesis") throw new TypeError("connection reset")
      return response
    }
    const prepared = await prepareFirstDevice(a.context, input("A", "desktop"))
    expect(await commitFirstDevice(a.context, prepared)).toMatchObject({ kind: "created" })
    expect(await a.context.vault.loadDeviceKeys()).not.toBeNull()
  })

  it("ends a request that is denied, mismatched or cancelled, appending nothing", async () => {
    const server = createFakeSyncServer({ spaceId: SPACE })
    const { a } = await createSpace(server)
    const aKeys = await a.keys()

    const denied = deviceOn(server, "denied")
    const deniedJoin = await startJoin(denied.context, input("X", "web"))
    await denyRequest(a.context, aKeys, deniedJoin.requestId, "denied")
    expect(await pollJoin(denied.context, deniedJoin)).toEqual({ phase: "ended", reason: "denied" })

    const mismatched = deviceOn(server, "mismatched")
    const mismatchJoin = await startJoin(mismatched.context, input("Y", "web"))
    const { approval } = await codes(a, mismatched, mismatchJoin)
    await denyRequest(a.context, aKeys, mismatchJoin.requestId, "mismatch", approval)
    expect(await pollJoin(mismatched.context, mismatchJoin)).toEqual({
      phase: "ended",
      reason: "mismatch",
    })

    const cancelled = deviceOn(server, "cancelled")
    const cancelJoinRequest = await startJoin(cancelled.context, input("Z", "web"))
    await cancelJoin(cancelled.context, cancelJoinRequest)
    expect(await pollJoin(cancelled.context, cancelJoinRequest)).toEqual({
      phase: "ended",
      reason: "cancelled",
    })

    expect(server.entries).toHaveLength(1)
  })
})

describe("a lying server", () => {
  it("cannot substitute the new device's keys: the codes differ", async () => {
    const server = createFakeSyncServer({ spaceId: SPACE })
    const { a } = await createSpace(server)
    const b = deviceOn(server, "b")
    const join = await startJoin(b.context, input("B", "web"))
    const impostorKeys = await importDeviceKeys(await generateDeviceKeyMaterial())
    a.rewrite.current = async (path, response) => {
      if (path !== "/v1/enroll/requests") return response
      const body = (await response.json()) as { requests: { signPub: string; encPub: string }[] }
      for (const request of body.requests) {
        request.signPub = impostorKeys.signPub
        request.encPub = impostorKeys.encPub
      }
      return Response.json(body)
    }
    const { joinerView, approverView } = await codes(a, b, join)
    expect((joinerView as { code: string }).code).not.toBe((approverView as { code: string }).code)
  })

  it("cannot grind the code by showing the new device another approver nonce", async () => {
    const server = createFakeSyncServer({ spaceId: SPACE })
    const { a } = await createSpace(server)
    const b = deviceOn(server, "b")
    const join = await startJoin(b.context, input("B", "web"))
    b.rewrite.current = async (path, response) => {
      if (!path.startsWith("/v1/enroll/requests/")) return response
      const body = (await response.json()) as { nonceA: string | null }
      if (body.nonceA) body.nonceA = Buffer.from(new Uint8Array(32).fill(9)).toString("base64url")
      return Response.json(body)
    }
    const { joinerView, approverView } = await codes(a, b, join)
    expect((joinerView as { code: string }).code).not.toBe((approverView as { code: string }).code)
  })

  it("cannot hand the approver a nonce the new device never committed to", async () => {
    const server = createFakeSyncServer({ spaceId: SPACE })
    const { a } = await createSpace(server)
    const b = deviceOn(server, "b")
    const join = await startJoin(b.context, input("B", "web"))
    const aKeys = await a.keys()
    const [incoming] = await listIncoming(a.context, aKeys)
    const approval = await beginApproval(a.context, aKeys, incoming!)
    await pollJoin(b.context, join)
    a.rewrite.current = async (path, response) => {
      if (path !== "/v1/enroll/requests") return response
      const body = (await response.json()) as { requests: { nonceR: string | null }[] }
      for (const request of body.requests)
        if (request.nonceR)
          request.nonceR = Buffer.from(new Uint8Array(32).fill(3)).toString("base64url")
      return Response.json(body)
    }
    await expect(pollApproval(a.context, aKeys, approval)).rejects.toMatchObject({
      code: "commit-mismatch",
    })
  })

  it("cannot show the new device a forged device list", async () => {
    const server = createFakeSyncServer({ spaceId: SPACE, skipNameCheck: true })
    const { a } = await createSpace(server)
    const forgedServer = createFakeSyncServer({ spaceId: SPACE })
    await createSpace(forgedServer, "forger")
    const b = deviceOn(server, "b")
    // B sees the forged list when it asks…
    b.rewrite.current = async (path, response, request) =>
      path === "/v1/registry" ? forgedServer.fetch(request) : response
    const join = await startJoin(b.context, input("B", "web"))
    b.rewrite.current = null
    // …so its code (bound to the forged genesis) differs from the real approver's,
    // and even an approval does not complete: B pinned the list it saw, and the
    // real one is a different history (a fork), which is proof of a lying server.
    const { joinerView, approverView, approval, approverKeys, incoming } = await codes(a, b, join)
    expect(incoming.displayName).toBeNull()
    expect((joinerView as { code: string }).code).not.toBe((approverView as { code: string }).code)
    await confirmApproval(a.context, approverKeys, approval)
    await pollJoin(b.context, join)
    const error = await completeJoin(b.context, join).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RegistryIntegrityError)
    expect((error as RegistryIntegrityError).reason).toBe("fork")
    expect(await b.context.vault.loadDeviceKeys()).toBeNull()
  })

  it("cannot seal its own key to a device", async () => {
    const server = createFakeSyncServer({ spaceId: SPACE })
    const { a } = await createSpace(server)
    const b = deviceOn(server, "b")
    const join = await startJoin(b.context, input("B", "web"))
    const { approval, approverKeys } = await codes(a, b, join)
    await confirmApproval(a.context, approverKeys, approval)
    await pollJoin(b.context, join)
    b.rewrite.current = async (path, response) => {
      if (path !== "/v1/envelopes/self") return response
      const forged = await sealEpochEnvelope(SPACE, 1, newEpochKey(), {
        recipient: join.keys.deviceId,
        encPub: join.keys.encPub,
      })
      return Response.json({ envelope: forged })
    }
    await expect(completeJoin(b.context, join)).rejects.toMatchObject({ code: "key_commitment" })
  })

  it("cannot roll a device back to an older list", async () => {
    const server = createFakeSyncServer({ spaceId: SPACE })
    const { a } = await createSpace(server)
    await rotateKeys(a.context, await a.keys())
    a.rewrite.current = async (path, response) => {
      if (path !== "/v1/registry") return response
      const body = (await response.json()) as { entries: unknown[] }
      return Response.json({ ...body, entries: body.entries.slice(0, 1) })
    }
    expect(await readEnrollmentStatus(a.context)).toEqual({ kind: "integrity", reason: "rollback" })
    await expect(rotateKeys(a.context, await a.keys())).rejects.toBeInstanceOf(
      RegistryIntegrityError
    )
    expect(await a.context.vault.loadDeviceKeys()).not.toBeNull()
  })

  it("cannot make a device forget its keys with a bare 403", async () => {
    const server = createFakeSyncServer({ spaceId: SPACE })
    const { a } = await createSpace(server)
    const b = deviceOn(server, "b")
    await joinByApproval(a, b, "B", "web")
    expect(await handleRevokedAnswer(b.context, await b.keys())).toBeNull()
    expect(await b.context.vault.loadDeviceKeys()).not.toBeNull()
  })

  it("cannot make a device use a stale epoch's envelope", async () => {
    const server = createFakeSyncServer({ spaceId: SPACE })
    const { a } = await createSpace(server)
    const b = deviceOn(server, "b")
    await joinByApproval(a, b, "B", "web")
    const stale = server.envelopes.get((await b.keys()).deviceId)!
    await rotateKeys(a.context, await a.keys())
    b.rewrite.current = (path, response) =>
      path === "/v1/envelopes/self" ? Response.json({ envelope: stale }) : response
    const status = await readEnrollmentStatus(b.context)
    if (status.kind !== "enrolled") throw new Error("not enrolled")
    await expect(
      currentKeyChain(b.context.api, b.context.vault, status.registry.state, status.device)
    ).rejects.toMatchObject({
      code: "bad_envelope",
    })
  })
})
