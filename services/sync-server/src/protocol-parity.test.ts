/**
 * The frozen protocol vectors (packages/sync-protocol/fixtures/v1.json) run
 * inside workerd: the Worker folds and verifies exactly what Node does.
 */
import { describe, expect, it } from "vitest"

import {
  RegistryError,
  decryptOpPayload,
  foldRegistry,
  fromBase64Url,
  importEcdsaPublicKey,
  mergeDelete,
  mergeUpsert,
  opKey,
  parseDeviceProof,
  parseOp,
  sasCode,
  verifyDeviceProof,
  verifyOpSignature,
  type RowClocks,
} from "@cognia/sync-protocol"

import V1 from "../../../packages/sync-protocol/fixtures/v1.json"
import OPS from "../../../packages/sync-protocol/fixtures/v1-ops.json"

const bytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map((pair) => parseInt(pair, 16)))

describe("protocol v1 in workerd", () => {
  it("folds the frozen chain", async () => {
    const folded = await foldRegistry(V1.registry.entries, { spaceId: V1.registry.spaceId })
    expect(folded!.entries.map((entry) => entry.hash)).toEqual(V1.registry.expected.hashes)
    expect(folded!.state.head).toEqual(V1.registry.expected.head)
  })

  it("refuses the frozen invalid chains", async () => {
    for (const item of V1.registry.invalid) {
      const error = await foldRegistry(item.elements, {
        spaceId: V1.registry.spaceId,
        pin: (item as { pin?: { genesisHash: string; seq: number; hash: string; epoch: number } })
          .pin,
      }).then(
        () => null,
        (caught: unknown) => caught
      )
      expect(error, item.name).toBeInstanceOf(RegistryError)
      expect((error as RegistryError).code, item.name).toBe(item.code)
    }
  })

  it("computes the frozen approval code and verifies the frozen device proof", async () => {
    expect(
      await sasCode(bytes(V1.sas.nonceR), bytes(V1.sas.nonceA), V1.sas.transcript as never)
    ).toBe(V1.sas.code)
    const { signPub, bodySha256, request, header } = V1.deviceProof
    await expect(
      verifyDeviceProof(parseDeviceProof(header), signPub, { ...request, bodySha256 })
    ).resolves.toBeTruthy()
  })
})

describe("protocol v1 op log in workerd", () => {
  it("verifies, opens and merges the frozen ops", async () => {
    const { spaceId, epochKey, signPub, payload } = OPS.sealed
    const op = parseOp(OPS.sealed.op)
    const publicKey = await importEcdsaPublicKey(fromBase64Url(signPub))
    expect(await verifyOpSignature(publicKey, spaceId, op)).toBe(true)
    expect(await decryptOpPayload(await opKey(bytes(epochKey), spaceId), spaceId, op)).toEqual(
      payload
    )
    for (const { exists, clocks, incoming, expected } of OPS.merge.upserts)
      expect(mergeUpsert(exists, clocks as RowClocks | undefined, incoming as never)).toEqual(
        expected
      )
    for (const { exists, clocks, at, expected } of OPS.merge.deletes)
      expect(mergeDelete(exists, clocks as RowClocks | undefined, at)).toEqual(expected)
  })
})
