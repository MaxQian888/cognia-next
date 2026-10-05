import { toBase64Url, utf8 } from "./bytes"
import { exportRawPublicKey } from "./crypto"
import {
  bodyDigest,
  createDeviceProof,
  DeviceProofError,
  parseDeviceProof,
  verifyDeviceProof,
} from "./device-proof"

async function device() {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  return { keys, signPub: toBase64Url(await exportRawPublicKey(keys.publicKey)) }
}

const SPACE = "s".repeat(43)
const DEVICE = "dev_0123456789ABCDEFGHJKMNPQRS"

describe("device proof", () => {
  it("binds the space, method, path and body, and verifies with the device key", async () => {
    const { keys, signPub } = await device()
    const body = utf8('{"x":1}')
    const bodySha256 = await bodyDigest(body)
    const header = await createDeviceProof(
      {
        v: 1,
        spaceId: SPACE,
        deviceId: DEVICE,
        method: "POST",
        path: "/v1/registry",
        bodySha256,
        iat: 1000,
      },
      keys.privateKey
    )
    const parsed = parseDeviceProof(header)
    const expected = { spaceId: SPACE, method: "post", path: "/v1/registry", bodySha256, now: 2000 }
    await expect(verifyDeviceProof(parsed, signPub, expected)).resolves.toMatchObject({
      deviceId: DEVICE,
    })

    await expect(
      verifyDeviceProof(parsed, signPub, { ...expected, path: "/v1/space" })
    ).rejects.toThrow("another request")
    await expect(
      verifyDeviceProof(parsed, signPub, { ...expected, now: 1000 + 121_000 })
    ).rejects.toMatchObject({ code: "clock_skew" })
    const other = await device()
    await expect(verifyDeviceProof(parsed, other.signPub, expected)).rejects.toThrow(
      "does not verify"
    )
  })

  it("refuses a malformed or non-canonical header", async () => {
    expect(() => parseDeviceProof(null)).toThrow(DeviceProofError)
    expect(() => parseDeviceProof("a.b.c")).toThrow("malformed")
    const loose = toBase64Url(
      utf8(
        JSON.stringify(
          {
            v: 1,
            spaceId: SPACE,
            deviceId: DEVICE,
            method: "GET",
            path: "/",
            bodySha256: "x",
            iat: 1,
          },
          null,
          1
        )
      )
    )
    expect(() => parseDeviceProof(`${loose}.AA`)).toThrow("non-canonical")
    const badId = toBase64Url(
      utf8(
        JSON.stringify({
          bodySha256: "x",
          deviceId: "usr_x",
          iat: 1,
          method: "GET",
          path: "/",
          spaceId: SPACE,
          v: 1,
        })
      )
    )
    expect(() => parseDeviceProof(`${badId}.AA`)).toThrow("malformed")
  })
})
