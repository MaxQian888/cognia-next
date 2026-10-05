/**
 * Frozen v1 vectors (fixtures/v1.json). A failure here means the wire format
 * changed: data already on a sync server would stop verifying. Fix the code,
 * or ship protocol v2; never regenerate the v1 file.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { utf8 } from "./bytes"
import { formatRecoveryKey, parseRecoveryKey } from "./crockford"
import { bodyDigest, parseDeviceProof, verifyDeviceProof } from "./device-proof"
import { keyCommitment, openDeviceName, unwrapPreviousKey } from "./epoch"
import { RegistryError } from "./errors"
import { spaceIdFor } from "./ids"
import { foldRegistry } from "./registry/fold"
import { listActiveDevices } from "./registry/validate-append"
import type { RegistryPin } from "./registry/pin"
import { matchesSasCommit, sasCode, sasCommit, transcriptHash } from "./sas"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V1: any = JSON.parse(readFileSync(path.join(__dirname, "..", "fixtures", "v1.json"), "utf8"))
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"))

describe("protocol v1 fixtures", () => {
  it("formats recovery keys", () => {
    for (const { hex, text } of V1.crockford) {
      expect(formatRecoveryKey(bytes(hex))).toBe(text)
      expect(parseRecoveryKey(text)).toEqual(bytes(hex))
    }
  })

  it("names spaces", async () => {
    for (const { issuer, subject, spaceId } of V1.spaceIds) {
      expect(await spaceIdFor(issuer, subject)).toBe(spaceId)
    }
    expect(new Set(V1.spaceIds.map((item: { spaceId: string }) => item.spaceId)).size).toBe(
      V1.spaceIds.length
    )
  })

  it("derives the approval commitment, transcript hash and code", async () => {
    const { nonceR, nonceA, commit, transcript } = V1.sas
    expect(await sasCommit(bytes(nonceR))).toBe(commit)
    expect(await matchesSasCommit(bytes(nonceR), commit)).toBe(true)
    expect(await transcriptHash(transcript)).toBe(V1.sas.transcriptHash)
    expect(await sasCode(bytes(nonceR), bytes(nonceA), transcript)).toBe(V1.sas.code)
  })

  it("commits, wraps and seals under an epoch key", async () => {
    const { spaceId, epoch, key, keyCommit, previousKey, prevWrap, deviceId, name, nameCt } =
      V1.epoch
    expect(await keyCommitment(bytes(key), spaceId, epoch)).toBe(keyCommit)
    expect(await unwrapPreviousKey(bytes(key), prevWrap, spaceId, epoch)).toEqual(
      bytes(previousKey)
    )
    expect(await openDeviceName(bytes(key), spaceId, deviceId, nameCt)).toBe(name)
  })

  it("verifies a device proof", async () => {
    const { signPub, body, bodySha256, request, header } = V1.deviceProof
    expect(await bodyDigest(utf8(body))).toBe(bodySha256)
    const payload = await verifyDeviceProof(parseDeviceProof(header), signPub, {
      ...request,
      bodySha256,
    })
    expect(payload.path).toBe(request.path)
  })

  it("folds the frozen chain to the frozen state", async () => {
    const { spaceId, entries, expected, epochKeys } = V1.registry
    const folded = (await foldRegistry(entries, { spaceId }))!
    expect(folded.entries.map((entry) => entry.hash)).toEqual(expected.hashes)
    expect(folded.state.genesisHash).toBe(expected.genesisHash)
    expect(folded.state.head).toEqual(expected.head)
    expect(folded.state.epoch).toBe(expected.epoch)
    expect(folded.state.recovery).toEqual(expected.recovery)
    expect(listActiveDevices(folded.state).map((device) => device.deviceId)).toEqual(
      expected.active
    )
    for (const id of expected.revoked) expect(folded.state.devices[id]!.status).toBe("revoked")
    for (const [id, name] of Object.entries(expected.names)) {
      const device = folded.state.devices[id]!
      const key = bytes(epochKeys[device.nameCt.epoch])
      expect(await openDeviceName(key, spaceId, id, device.nameCt)).toBe(name)
    }
    for (const [epoch, key] of Object.entries(epochKeys)) {
      expect(await keyCommitment(bytes(key as string), spaceId, Number(epoch))).toBe(
        folded.state.keyCommits[Number(epoch)]
      )
    }
  })

  type InvalidChain = { name: string; elements: unknown[]; pin?: RegistryPin; code: string }
  it.each((V1.registry.invalid as InvalidChain[]).map((item) => ({ ...item })))(
    "refuses a chain: $name",
    async (item: InvalidChain) => {
      const error = await foldRegistry(item.elements, {
        spaceId: V1.registry.spaceId,
        pin: item.pin,
      }).then(
        () => null,
        (caught: unknown) => caught
      )
      expect(error).toBeInstanceOf(RegistryError)
      expect((error as RegistryError).code).toBe(item.code)
    }
  )
})
