import {
  EMBEDDED_COGNIA_RELEASE_KEY_FINGERPRINT_SHA256,
  getCliReleaseVerificationMode,
  isPlaceholderReleaseKey,
} from "./embedded-pubkey"

describe("embedded CLI release key metadata", () => {
  it("exposes a generated SHA-256 fingerprint", () => {
    expect(EMBEDDED_COGNIA_RELEASE_KEY_FINGERPRINT_SHA256).toMatch(/^[a-f0-9]{64}$/)
  })

  it("reports checksum-only mode while the release key is a placeholder", () => {
    expect(isPlaceholderReleaseKey()).toBe(true)
    expect(getCliReleaseVerificationMode()).toBe("checksum-only")
  })
})
