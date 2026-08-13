/** @jest-environment node */

import { decryptPerformanceArtifact, encryptPerformanceArtifact } from "./capture-crypto"
import {
  __resetPerformanceSecurityGenerationForTests,
  bumpPerformanceSecurityGeneration,
} from "./security-generation"

const aad = {
  accountId: "account-a",
  targetDatabase: "db-a",
  captureId: "capture-a",
  ordinal: 0,
  contentType: "application/vnd.cognia.perf-frames+json",
}

describe("performance artifact crypto", () => {
  beforeEach(__resetPerformanceSecurityGenerationForTests)

  it("binds ciphertext to account, target database, capture, ordinal, and content type", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const envelope = await encryptPerformanceArtifact(
      key,
      new TextEncoder().encode("private"),
      aad,
      0
    )
    await expect(decryptPerformanceArtifact(key, envelope, aad, 0)).resolves.toEqual(
      new TextEncoder().encode("private")
    )
    await expect(
      decryptPerformanceArtifact(key, envelope, { ...aad, captureId: "capture-b" }, 0)
    ).rejects.toThrow()
  })

  it("rechecks the security generation after WebCrypto", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    bumpPerformanceSecurityGeneration("account-a", "account-locked")
    await expect(
      encryptPerformanceArtifact(key, new TextEncoder().encode("private"), aad, 0)
    ).rejects.toThrow("performance-security-generation-changed")
  })
})
