import { fromBase64Url, isDeviceId } from "@cognia/sync-protocol"

import {
  generateDeviceKeyMaterial,
  importDeviceKeys,
  parseDeviceKeyMaterial,
  type DeviceKeyMaterial,
} from "./device-keys"
import { AccountSyncCryptoError } from "./errors"

describe("device keys", () => {
  it("generates material with raw public points and a dev_ id", async () => {
    const material = await generateDeviceKeyMaterial()
    expect(isDeviceId(material.deviceId)).toBe(true)
    expect(fromBase64Url(material.signPub)).toHaveLength(65)
    expect(fromBase64Url(material.encPub)).toHaveLength(65)
    expect(material.signPub).not.toBe(material.encPub)
    expect((await generateDeviceKeyMaterial("dev_" + "0".repeat(26))).deviceId).toBe(
      "dev_" + "0".repeat(26)
    )
    await expect(generateDeviceKeyMaterial("usr_1")).rejects.toThrow(/dev_/)
  })

  it("survives the vault's JSON round trip and imports non-extractable", async () => {
    const material = await generateDeviceKeyMaterial()
    const stored = JSON.parse(JSON.stringify(material)) as DeviceKeyMaterial
    const keys = await importDeviceKeys(stored)
    expect(keys.deviceId).toBe(material.deviceId)
    expect(keys.signPub).toBe(material.signPub)
    expect(keys.sign.privateKey.extractable).toBe(false)
    expect(keys.enc.privateKey.extractable).toBe(false)
  })

  it("refuses material it did not write", async () => {
    const material = await generateDeviceKeyMaterial()
    const other = await generateDeviceKeyMaterial()
    const bad: unknown[] = [
      null,
      { ...material, v: 2 },
      { ...material, deviceId: "dev_short" },
      { ...material, signJwk: { ...material.signJwk, crv: "P-384" } },
      { ...material, encJwk: "x" },
      { ...material, signPub: other.signPub },
      { ...material, encJwk: { ...material.encJwk, x: "AA" } },
    ]
    for (const value of bad) {
      expect(() => parseDeviceKeyMaterial(value)).toThrow(AccountSyncCryptoError)
    }
  })

  it("reports a key that no longer imports as bad material", async () => {
    const material = await generateDeviceKeyMaterial()
    const other = await generateDeviceKeyMaterial()
    // Public halves agree with the JWK coordinates, but `d` belongs to another key.
    const mixed = { ...material, signJwk: { ...material.signJwk, d: other.signJwk.d } }
    await expect(importDeviceKeys(mixed)).rejects.toMatchObject({ code: "bad_key_material" })
  })
})
