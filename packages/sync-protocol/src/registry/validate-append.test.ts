import { toBase64Url } from "../bytes"
import { RegistryError, type RegistryErrorCode } from "../errors"
import { MAX_ACTIVE_DEVICES } from "../limits"
import { keyCommitment, newEpochKey } from "../epoch"
import {
  ChainBuilder,
  deviceSigner,
  makeDevice,
  makeRecovery,
  recoverySigner,
  signWith,
  type TestDevice,
  type TestKeyPair,
} from "../testing/chain"
import { entryHash } from "./encode"
import type { GenesisEntry, RegistryEntry, SignedEntry } from "./types"
import {
  NAME_CIPHERTEXT_BYTES,
  listActiveDevices,
  parseSignedEntry,
  validateAppend,
} from "./validate-append"

const SPACE = "s".repeat(43)

/** A JSON copy of an element, edited field by field to test the parser. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tamperable = Record<string, any>

async function expectRefused(
  promise: Promise<unknown>,
  code: RegistryErrorCode
): Promise<RegistryError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(RegistryError)
  expect((error as RegistryError).code).toBe(code)
  return error as RegistryError
}

/** A deep copy that can be tampered with. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

interface Space {
  chain: ChainBuilder
  first: TestDevice
  recovery: TestKeyPair
}

async function space(): Promise<Space> {
  const first = await makeDevice("First")
  const recovery = await makeRecovery()
  return { chain: await ChainBuilder.genesis(SPACE, first, recovery), first, recovery }
}

describe("genesis", () => {
  it("starts epoch 1 with the device and the recovery key", async () => {
    const { chain, first, recovery } = await space()
    const state = chain.state
    expect(state.head).toEqual({ seq: 0, hash: state.genesisHash })
    expect(state.genesisHash).toBe(await entryHash(chain.entries[0]!.entry))
    expect(state.epoch).toBe(1)
    expect(state.recovery).toEqual({ signPub: recovery.signPub, encPub: recovery.encPub })
    expect(state.devices[first.deviceId]).toMatchObject({
      status: "active",
      addedSeq: 0,
      addedVia: "genesis",
      addedBy: null,
    })
    expect(state.usedKeys).toEqual(
      expect.arrayContaining([first.signPub, first.encPub, recovery.signPub, recovery.encPub])
    )
    expect(state.prevWraps).toEqual({})
  })

  it("needs both the device's and the recovery key's signatures", async () => {
    const { chain, first, recovery } = await space()
    const entry = chain.entries[0]!.entry
    await expectRefused(
      validateAppend(null, await signWith(entry, [deviceSigner(first)]), SPACE),
      "bad_signature"
    )
    await expectRefused(
      validateAppend(null, await signWith(entry, [recoverySigner(recovery)]), SPACE),
      "bad_signature"
    )
    const other = await makeRecovery()
    await expectRefused(
      validateAppend(
        null,
        await signWith(entry, [deviceSigner(first), recoverySigner(other)]),
        SPACE
      ),
      "bad_signature"
    )
  })

  it("refuses a first entry that is not genesis, and a second genesis", async () => {
    const { chain } = await space()
    await expectRefused(validateAppend(chain.state, chain.entries[0]!, SPACE), "bad_genesis")
    const device = await makeDevice()
    const rotate: RegistryEntry = {
      v: 1,
      spaceId: SPACE,
      seq: 0,
      prev: null,
      type: "epoch-rotate",
      at: 1,
      epoch: { epoch: 1, keyCommit: toBase64Url(new Uint8Array(32)) },
    }
    await expectRefused(
      validateAppend(null, await signWith(rotate, [deviceSigner(device)]), SPACE),
      "bad_genesis"
    )
  })

  it("refuses an entry of another space", async () => {
    const { chain } = await space()
    await expectRefused(validateAppend(null, chain.entries[0]!, "t".repeat(43)), "malformed")
  })

  it("refuses genesis that reuses a key between the device and the recovery key", async () => {
    const first = await makeDevice()
    const genesis = (await ChainBuilder.genesis(SPACE, first, await makeRecovery())).entries[0]!
      .entry as GenesisEntry
    const reused = { ...(await makeRecovery()), sign: first.sign, signPub: first.signPub }
    const entry: GenesisEntry = {
      ...genesis,
      recovery: { signPub: reused.signPub, encPub: reused.encPub },
    }
    // Both signatures verify (one key signs twice); the rule refuses it.
    const error = await expectRefused(
      validateAppend(
        null,
        await signWith(entry, [deviceSigner(first), recoverySigner(reused)]),
        SPACE
      ),
      "rule"
    )
    expect(error.message).toMatch(/reuses/)
  })
})

describe("approval", () => {
  it("adds a device signed by one active device", async () => {
    const { chain, first } = await space()
    const second = await makeDevice("Second", "mobile")
    await chain.addByApproval(first, second)
    expect(chain.state.head.seq).toBe(1)
    expect(chain.state.devices[second.deviceId]).toMatchObject({
      status: "active",
      addedSeq: 1,
      addedVia: "approval",
      addedBy: first.deviceId,
      platform: "mobile",
    })
    expect(chain.state.epoch).toBe(1)
    expect(listActiveDevices(chain.state).map((device) => device.deviceId)).toEqual([
      first.deviceId,
      second.deviceId,
    ])
  })

  it("refuses an approver that is not an active device", async () => {
    const { chain } = await space()
    const stranger = await makeDevice()
    const second = await makeDevice()
    const entry: RegistryEntry = {
      ...chain.base(),
      type: "add-device",
      via: "approval",
      device: await chain.descriptor(second),
      requestId: "req_" + "0".repeat(26),
      transcriptHash: toBase64Url(new Uint8Array(32)),
    }
    await expectRefused(
      validateAppend(chain.state, await signWith(entry, [deviceSigner(stranger)]), SPACE),
      "rule"
    )
    // The device approving itself is not an active device either.
    await expectRefused(
      validateAppend(chain.state, await signWith(entry, [deviceSigner(second)]), SPACE),
      "rule"
    )
  })

  it("refuses an approval with a second signature", async () => {
    const { chain, first, recovery } = await space()
    const second = await makeDevice()
    const entry: RegistryEntry = {
      ...chain.base(),
      type: "add-device",
      via: "approval",
      device: await chain.descriptor(second),
      requestId: "req_" + "0".repeat(26),
      transcriptHash: toBase64Url(new Uint8Array(32)),
    }
    await expectRefused(
      validateAppend(
        chain.state,
        await signWith(entry, [deviceSigner(first), recoverySigner(recovery)]),
        SPACE
      ),
      "bad_signature"
    )
    await expectRefused(
      validateAppend(
        chain.state,
        await signWith(entry, [deviceSigner(first), deviceSigner(second)]),
        SPACE
      ),
      "rule"
    )
  })

  it("refuses a reused device id or key, and a name under an old epoch", async () => {
    const { chain, first } = await space()
    const second = await makeDevice()
    await chain.addByApproval(first, second)

    const sameId = { ...(await makeDevice()), deviceId: second.deviceId }
    await expectRefused(chain.addByApproval(first, sameId), "rule")

    const sameKey = { ...(await makeDevice()), sign: second.sign, signPub: second.signPub }
    await expectRefused(chain.addByApproval(first, sameKey), "rule")

    const recoveryKey = {
      ...(await makeDevice()),
      enc: chain.state.recovery,
      encPub: chain.state.recovery.encPub,
    }
    await expectRefused(chain.addByApproval(first, recoveryKey as unknown as TestDevice), "rule")

    await chain.rotateEpoch(first)
    const third = await makeDevice()
    const entry: RegistryEntry = {
      ...chain.base(),
      type: "add-device",
      via: "approval",
      device: await chain.descriptor(third, 1),
      requestId: "req_" + "0".repeat(26),
      transcriptHash: toBase64Url(new Uint8Array(32)),
    }
    const error = await expectRefused(
      validateAppend(chain.state, await signWith(entry, [deviceSigner(first)]), SPACE),
      "rule"
    )
    expect(error.message).toMatch(/current epoch/)
  })

  it(`caps the space at ${MAX_ACTIVE_DEVICES} active devices`, async () => {
    const { chain, first } = await space()
    for (let i = 1; i < MAX_ACTIVE_DEVICES; i++)
      await chain.addByApproval(first, await makeDevice(`D${i}`))
    expect(listActiveDevices(chain.state)).toHaveLength(MAX_ACTIVE_DEVICES)
    const error = await expectRefused(
      chain.addByApproval(first, await makeDevice("One too many")),
      "rule"
    )
    expect(error.message).toMatch(/at most/)
  }, 60_000)
})

describe("recovery", () => {
  it("adds a device with the recovery key and requires its epoch rotation next", async () => {
    const { chain, recovery } = await space()
    const phone = await makeDevice("Phone", "mobile")
    const [add, rotate] = await chain.addByRecovery(recovery, phone)
    expect(add!.sigs.map((sig) => sig.signer)).toEqual(["recovery", phone.deviceId])
    expect(rotate!.entry.type).toBe("epoch-rotate")
    expect(chain.state.devices[phone.deviceId]).toMatchObject({
      addedVia: "recovery",
      addedBy: "recovery",
    })
    expect(chain.state.epoch).toBe(2)
    expect(chain.state.pendingRecoveryRotate).toBeNull()
  })

  it("leaves the batch open after the add, and refuses anything but the new device's rotation", async () => {
    const { chain, first, recovery } = await space()
    const phone = await makeDevice()
    const add: RegistryEntry = {
      ...chain.base(),
      type: "add-device",
      via: "recovery",
      device: await chain.descriptor(phone),
    }
    const signedAdd = await signWith(add, [recoverySigner(recovery), deviceSigner(phone)])
    const { state } = await validateAppend(chain.state, signedAdd, SPACE)
    expect(state.pendingRecoveryRotate).toBe(phone.deviceId)
    await chain.push(signedAdd)

    const byOther: RegistryEntry = {
      ...chain.base(),
      type: "epoch-rotate",
      epoch: await chain.nextEpochBlock(),
    }
    await expectRefused(
      validateAppend(chain.state, await signWith(byOther, [deviceSigner(first)]), SPACE),
      "incomplete_batch"
    )
    const third = await makeDevice()
    const approval: RegistryEntry = {
      ...chain.base(),
      type: "add-device",
      via: "approval",
      device: await chain.descriptor(third, 1),
      requestId: "req_" + "0".repeat(26),
      transcriptHash: toBase64Url(new Uint8Array(32)),
    }
    await expectRefused(
      validateAppend(chain.state, await signWith(approval, [deviceSigner(phone)]), SPACE),
      "incomplete_batch"
    )
    await chain.push(await signWith(byOther, [deviceSigner(phone)]))
    expect(chain.state.pendingRecoveryRotate).toBeNull()
  })

  it("needs the current recovery key and the new device's own signature", async () => {
    const { chain, first, recovery } = await space()
    const phone = await makeDevice()
    const add: RegistryEntry = {
      ...chain.base(),
      type: "add-device",
      via: "recovery",
      device: await chain.descriptor(phone),
    }
    const forged = await makeRecovery()
    await expectRefused(
      validateAppend(
        chain.state,
        await signWith(add, [recoverySigner(forged), deviceSigner(phone)]),
        SPACE
      ),
      "bad_signature"
    )
    await expectRefused(
      validateAppend(chain.state, await signWith(add, [recoverySigner(recovery)]), SPACE),
      "bad_signature"
    )
    await expectRefused(
      validateAppend(
        chain.state,
        await signWith(add, [recoverySigner(recovery), deviceSigner(first)]),
        SPACE
      ),
      "bad_signature"
    )
  })

  it("refuses the old recovery key after a rotation", async () => {
    const { chain, first, recovery } = await space()
    const next = await makeRecovery()
    await chain.rotateRecovery(first, next)
    expect(chain.state.recovery.signPub).toBe(next.signPub)
    expect(chain.state.epoch).toBe(2)
    await expectRefused(chain.addByRecovery(recovery, await makeDevice()), "bad_signature")
    await chain.addByRecovery(next, await makeDevice())
  })

  it("needs the new recovery key's countersignature, and a fresh key", async () => {
    const { chain, first, recovery } = await space()
    const next = await makeRecovery()
    const entry: RegistryEntry = {
      ...chain.base(),
      type: "recovery-rotate",
      recovery: { signPub: next.signPub, encPub: next.encPub },
      epoch: await chain.nextEpochBlock(),
    }
    await expectRefused(
      validateAppend(chain.state, await signWith(entry, [deviceSigner(first)]), SPACE),
      "bad_signature"
    )
    await expectRefused(
      validateAppend(
        chain.state,
        await signWith(entry, [deviceSigner(first), recoverySigner(recovery)]),
        SPACE
      ),
      "bad_signature"
    )
    await expectRefused(chain.rotateRecovery(first, recovery), "rule")
  })
})

describe("revocation", () => {
  it("revokes another device and starts the next epoch", async () => {
    const { chain, first } = await space()
    const second = await makeDevice()
    await chain.addByApproval(first, second)
    await chain.revoke(first, second.deviceId)
    expect(chain.state.devices[second.deviceId]).toMatchObject({
      status: "revoked",
      revokedSeq: 2,
      revokedBy: first.deviceId,
    })
    expect(chain.state.epoch).toBe(2)
    expect(chain.state.prevWraps[2]).toBeDefined()
    expect(listActiveDevices(chain.state).map((device) => device.deviceId)).toEqual([
      first.deviceId,
    ])
  })

  it("refuses a self-revoke, the last device, and an already revoked one", async () => {
    const { chain, first } = await space()
    await expectRefused(chain.revoke(first, first.deviceId), "rule")

    const second = await makeDevice()
    await chain.addByApproval(first, second)
    const self = await expectRefused(chain.revoke(second, second.deviceId), "rule")
    expect(self.message).toMatch(/itself/)

    await chain.revoke(first, second.deviceId)
    await expectRefused(chain.revoke(first, second.deviceId), "rule")
  })

  it("refuses anything signed by a revoked device, and its keys forever", async () => {
    const { chain, first } = await space()
    const second = await makeDevice()
    await chain.addByApproval(first, second)
    await chain.revoke(first, second.deviceId)
    await expectRefused(chain.rotateEpoch(second), "rule")
    await expectRefused(chain.addByApproval(second, await makeDevice()), "rule")
    const again = { ...(await makeDevice()), sign: second.sign, signPub: second.signPub }
    await expectRefused(chain.addByApproval(first, again), "rule")
  })
})

describe("epochs", () => {
  it("numbers epochs consecutively", async () => {
    const { chain, first } = await space()
    await chain.rotateEpoch(first)
    const block = await chain.nextEpochBlock()
    const skipped: RegistryEntry = {
      ...chain.base(),
      type: "epoch-rotate",
      epoch: { ...block, epoch: 4 },
    }
    await expectRefused(
      validateAppend(chain.state, await signWith(skipped, [deviceSigner(first)]), SPACE),
      "rule"
    )
    const keyCommit = await keyCommitment(newEpochKey(), SPACE, 2)
    const repeated: RegistryEntry = {
      ...chain.base(),
      type: "epoch-rotate",
      epoch: { ...block, epoch: 2, keyCommit },
    }
    await expectRefused(
      validateAppend(chain.state, await signWith(repeated, [deviceSigner(first)]), SPACE),
      "rule"
    )
    expect(Object.keys(chain.state.keyCommits)).toEqual(["1", "2"])
  })

  it("refuses an epoch block without the previous key's wrap", async () => {
    const { chain, first } = await space()
    const { epoch, keyCommit } = await chain.nextEpochBlock()
    const entry = {
      ...chain.base(),
      type: "epoch-rotate",
      epoch: { epoch, keyCommit },
    } as RegistryEntry
    await expectRefused(
      validateAppend(chain.state, await signWith(entry, [deviceSigner(first)]), SPACE),
      "malformed"
    )
  })
})

describe("linking", () => {
  it("refuses an entry that does not extend the head", async () => {
    const { chain, first } = await space()
    const block = await chain.nextEpochBlock()
    const base = chain.base()
    const wrongSeq: RegistryEntry = { ...base, seq: 2, type: "epoch-rotate", epoch: block }
    await expectRefused(
      validateAppend(chain.state, await signWith(wrongSeq, [deviceSigner(first)]), SPACE),
      "bad_link"
    )
    const wrongPrev: RegistryEntry = {
      ...base,
      prev: toBase64Url(new Uint8Array(32).fill(1)),
      type: "epoch-rotate",
      epoch: block,
    }
    await expectRefused(
      validateAppend(chain.state, await signWith(wrongPrev, [deviceSigner(first)]), SPACE),
      "bad_link"
    )
  })

  it("refuses a replay of an earlier entry", async () => {
    const { chain, first } = await space()
    await chain.addByApproval(first, await makeDevice())
    await chain.rotateEpoch(first)
    await expectRefused(validateAppend(chain.state, chain.entries[1]!, SPACE), "bad_link")
  })

  it("refuses a tampered entry whose signature no longer covers it", async () => {
    const { chain, first } = await space()
    const signed = await signWith(
      { ...chain.base(), type: "epoch-rotate", epoch: await chain.nextEpochBlock() },
      [deviceSigner(first)]
    )
    const tampered = copy(signed)
    tampered.entry.at += 1
    await expectRefused(validateAppend(chain.state, tampered, SPACE), "bad_signature")
    await validateAppend(chain.state, signed, SPACE)
  })
})

describe("strict parsing", () => {
  let chain: ChainBuilder
  let first: TestDevice
  let signed: SignedEntry

  beforeAll(async () => {
    ;({ chain, first } = await space())
    signed = await signWith(
      {
        ...chain.base(),
        type: "add-device",
        via: "approval",
        device: await chain.descriptor(await makeDevice()),
        requestId: "req_" + "1".repeat(26),
        transcriptHash: toBase64Url(new Uint8Array(32).fill(3)),
      },
      [deviceSigner(first)]
    )
  })

  async function refusesWith(
    mutate: (value: Tamperable) => void,
    code: RegistryErrorCode = "malformed"
  ) {
    const value = copy(signed) as unknown as Tamperable
    mutate(value)
    return expectRefused(validateAppend(chain.state, value, SPACE), code)
  }

  it("accepts the untouched element", async () => {
    await expect(parseSignedEntry(copy(signed), SPACE)).resolves.toEqual(signed)
  })

  it("refuses unknown fields at every level", async () => {
    await refusesWith((value) => (value.extra = 1))
    await refusesWith((value) => (value.entry.note = "hi"))
    await refusesWith((value) => (value.entry.device.label = "x"))
    await refusesWith((value) => (value.entry.device.nameCt.alg = "x"))
    await refusesWith((value) => (value.sigs[0].kid = "x"))
  })

  it("refuses wrong lengths and non-canonical base64url", async () => {
    await refusesWith((value) => (value.entry.transcriptHash = toBase64Url(new Uint8Array(31))))
    await refusesWith((value) => (value.entry.transcriptHash += "="))
    await refusesWith(
      (value) =>
        (value.entry.device.nameCt.ct = toBase64Url(new Uint8Array(NAME_CIPHERTEXT_BYTES - 1)))
    )
    await refusesWith(
      (value) => (value.entry.device.nameCt.nonce = toBase64Url(new Uint8Array(16)))
    )
    await refusesWith((value) => (value.sigs[0].sig = toBase64Url(new Uint8Array(72))))
  })

  it("refuses keys that are not P-256 points", async () => {
    await refusesWith((value) => (value.entry.device.signPub = toBase64Url(new Uint8Array(65))))
    const notOnCurve = new Uint8Array(65).fill(5)
    notOnCurve[0] = 4
    await refusesWith((value) => (value.entry.device.encPub = toBase64Url(notOnCurve)))
  })

  it("refuses bad ids, versions, types and signer lists", async () => {
    await refusesWith((value) => (value.entry.v = 2))
    await refusesWith((value) => (value.entry.type = "merge-device"))
    await refusesWith((value) => (value.entry.via = "magic"))
    await refusesWith((value) => (value.entry.requestId = "req_short"))
    await refusesWith((value) => (value.entry.device.deviceId = "usr_" + "0".repeat(26)))
    await refusesWith((value) => (value.entry.device.platform = "toaster"))
    await refusesWith((value) => (value.entry.seq = 1.5))
    await refusesWith((value) => (value.entry.at = -1))
    await refusesWith((value) => (value.sigs = []))
    await refusesWith((value) => (value.sigs = [value.sigs[0], value.sigs[0]]))
    await refusesWith((value) => (value.sigs[0].signer = "admin"))
  })

  it("refuses headless devices in this protocol version", async () => {
    const error = await refusesWith((value) => (value.entry.device.platform = "headless"), "rule")
    expect(error.message).toMatch(/headless/)
  })

  it("refuses an element over the size limit", async () => {
    // Every field is bounded, so only an oversized space id (supplied by the
    // caller, never by the element) can reach the limit.
    const huge = "s".repeat(9000)
    const value = copy(signed) as unknown as Tamperable
    value.entry.spaceId = huge
    const error = await expectRefused(parseSignedEntry(value, huge), "rule")
    expect(error.message).toMatch(/at most/)
  })
})
