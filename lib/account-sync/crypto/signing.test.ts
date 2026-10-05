import {
  bodyDigest,
  enrollRequestSigningBytes,
  ecdsaVerify,
  fromBase64Url,
  parseDeviceProof,
  sealDeviceName,
  validateAppend,
  verifyDeviceProof,
  type RegistryEntry,
} from "@cognia/sync-protocol"
import { ChainBuilder, makeDevice, makeRecovery } from "@cognia/sync-protocol/testing/chain"

import { generateDeviceKeyMaterial, importDeviceKeys } from "./device-keys"
import { firstEpoch } from "./epoch-keys"
import { deriveRecoveryKeys, newRecoveryKey } from "./recovery"
import { deviceProofHeader, enrollRequestPop, signRegistryEntry } from "./signing"

const SPACE = "s".repeat(43)

describe("signing", () => {
  it("signs a genesis entry the registry accepts, as the device and the recovery key", async () => {
    const keys = await importDeviceKeys(await generateDeviceKeyMaterial())
    const recovery = await deriveRecoveryKeys(newRecoveryKey(), SPACE)
    const epoch = await firstEpoch(SPACE)
    const entry: RegistryEntry = {
      v: 1,
      spaceId: SPACE,
      seq: 0,
      prev: null,
      type: "genesis",
      at: Date.now(),
      device: {
        deviceId: keys.deviceId,
        platform: "desktop",
        signPub: keys.signPub,
        encPub: keys.encPub,
        nameCt: await sealDeviceName(epoch.key, SPACE, keys.deviceId, 1, "Mac"),
      },
      recovery: { signPub: recovery.signPub, encPub: recovery.encPub },
      epoch: epoch.block,
    }
    const signed = await signRegistryEntry(entry, [
      { kind: "device", keys },
      { kind: "recovery", keys: recovery },
    ])
    expect(signed.sigs.map((sig) => sig.signer)).toEqual([keys.deviceId, "recovery"])
    const { state } = await validateAppend(null, signed, SPACE)
    expect(state.devices[keys.deviceId]!.status).toBe("active")
  })

  it("signs as an approver in an existing chain", async () => {
    const material = await generateDeviceKeyMaterial()
    const keys = await importDeviceKeys(material)
    const chain = await ChainBuilder.genesis(
      SPACE,
      {
        ...(await makeDevice()),
        ...material,
        sign: keys.sign,
        enc: keys.enc,
        platform: "desktop",
        name: "A",
      },
      await makeRecovery()
    )
    const block = await chain.nextEpochBlock()
    const signed = await signRegistryEntry(
      { ...chain.base(), type: "epoch-rotate", epoch: block },
      [{ kind: "device", keys }]
    )
    await chain.push(signed)
    expect(chain.state.epoch).toBe(2)
  })

  it("produces a device proof the server verifies", async () => {
    const keys = await importDeviceKeys(await generateDeviceKeyMaterial())
    const body = new TextEncoder().encode('{"a":1}')
    const header = await deviceProofHeader(keys, {
      spaceId: SPACE,
      method: "post",
      path: "/v1/registry",
      body,
      now: 1_000_000.4,
    })
    const parsed = parseDeviceProof(header)
    expect(parsed.payload).toMatchObject({
      deviceId: keys.deviceId,
      method: "POST",
      iat: 1_000_000,
    })
    await verifyDeviceProof(parsed, keys.signPub, {
      spaceId: SPACE,
      method: "POST",
      path: "/v1/registry",
      bodySha256: await bodyDigest(body),
      now: 1_000_000,
    })
    const empty = parseDeviceProof(
      await deviceProofHeader(keys, {
        spaceId: SPACE,
        method: "GET",
        path: "/v1/envelopes/self",
        now: 5,
      })
    )
    expect(empty.payload.bodySha256).toBe(await bodyDigest(new Uint8Array()))
  })

  it("signs an enrollment request's proof of possession", async () => {
    const keys = await importDeviceKeys(await generateDeviceKeyMaterial())
    const body = {
      deviceId: keys.deviceId,
      platform: "web",
      signPub: keys.signPub,
      encPub: keys.encPub,
    }
    const pop = await enrollRequestPop(keys, body)
    expect(
      await ecdsaVerify(
        fromBase64Url(keys.signPub),
        fromBase64Url(pop),
        enrollRequestSigningBytes(body)
      )
    ).toBe(true)
    expect(
      await ecdsaVerify(
        fromBase64Url(keys.signPub),
        fromBase64Url(pop),
        enrollRequestSigningBytes({ ...body, platform: "mobile" })
      )
    ).toBe(false)
  })
})
