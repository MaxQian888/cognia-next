import { toBase64Url } from "@cognia/sync-protocol"

import { registryFingerprint } from "./fingerprint"

describe("registryFingerprint", () => {
  it("shortens the head hash to four groups of four", () => {
    const hash = toBase64Url(new Uint8Array(32).fill(0))
    expect(registryFingerprint({ head: { seq: 0, hash } })).toBe("0000 0000 0000 0000")
    const other = registryFingerprint({
      head: { seq: 1, hash: toBase64Url(new Uint8Array(32).fill(255)) },
    })
    expect(other).toMatch(/^([0-9A-Z]{4} ){3}[0-9A-Z]{4}$/)
    expect(other).not.toBe("0000 0000 0000 0000")
  })
})
