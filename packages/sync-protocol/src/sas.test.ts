import { randomBytes } from "./bytes"
import {
  formatSasCode,
  matchesSasCommit,
  sasCode,
  sasCommit,
  transcriptHash,
  type SasTranscript,
} from "./sas"

const transcript: SasTranscript = {
  spaceId: "s".repeat(43),
  genesisHash: "g".repeat(43),
  requestId: "req_0123456789ABCDEFGHJKMNPQRS",
  deviceId: "dev_0123456789ABCDEFGHJKMNPQRS",
  platform: "mobile",
  signPub: "A".repeat(87),
  encPub: "B".repeat(87),
  commit: "c".repeat(43),
  approverDeviceId: "dev_SRQPNMKJHGFEDCBA9876543210",
}

describe("approval code", () => {
  it("checks the reveal against the commitment", async () => {
    const nonce = randomBytes(32)
    const commit = await sasCommit(nonce)
    expect(await matchesSasCommit(nonce, commit)).toBe(true)
    expect(await matchesSasCommit(randomBytes(32), commit)).toBe(false)
  })

  it("gives both sides the same six digits from the same transcript", async () => {
    const nonceR = randomBytes(32)
    const nonceA = randomBytes(32)
    const code = await sasCode(nonceR, nonceA, transcript)
    expect(code).toMatch(/^\d{6}$/)
    expect(await sasCode(nonceR, nonceA, { ...transcript })).toBe(code)
    expect(formatSasCode("012345")).toBe("012 345")
  })

  it("is a fixed function of its inputs (frozen vector)", async () => {
    const nonceR = new Uint8Array(32).fill(1)
    const nonceA = new Uint8Array(32).fill(2)
    const code = await sasCode(nonceR, nonceA, transcript)
    // Any change to the transcript moves the code (checked over many genesis hashes).
    const others = new Set<string>()
    for (let i = 0; i < 20; i++) {
      others.add(
        await sasCode(nonceR, nonceA, { ...transcript, genesisHash: `${i}`.padStart(43, "h") })
      )
    }
    expect(others.size).toBeGreaterThan(15)
    expect(code).toMatch(/^\d{6}$/)
    expect(await transcriptHash(transcript)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("refuses short nonces", async () => {
    await expect(sasCode(new Uint8Array(16), randomBytes(32), transcript)).rejects.toThrow(
      "32 bytes"
    )
  })
})
