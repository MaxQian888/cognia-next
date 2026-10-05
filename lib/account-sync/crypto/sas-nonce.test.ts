import { SAS_NONCE_BYTES, matchesSasCommit, type SasTranscript } from "@cognia/sync-protocol"

import { displayedSasCode, newApproverNonce, newRequesterNonce, wipeNonce } from "./sas-nonce"

const TRANSCRIPT: SasTranscript = {
  spaceId: "s".repeat(43),
  genesisHash: "g".repeat(43),
  requestId: "req_" + "0".repeat(26),
  deviceId: "dev_" + "1".repeat(26),
  platform: "web",
  signPub: "S",
  encPub: "E",
  commit: "C",
  approverDeviceId: "dev_" + "2".repeat(26),
}

describe("approval nonces", () => {
  it("commits to the requester's nonce", async () => {
    const { nonceR, commit } = await newRequesterNonce()
    expect(nonceR).toHaveLength(SAS_NONCE_BYTES)
    expect(await matchesSasCommit(nonceR, commit)).toBe(true)
    expect((await newRequesterNonce()).commit).not.toBe(commit)
  })

  it("shows the same six digits on both sides, grouped 3 + 3", async () => {
    const { nonceR } = await newRequesterNonce()
    const nonceA = newApproverNonce()
    expect(nonceA).toHaveLength(SAS_NONCE_BYTES)
    const code = await displayedSasCode(nonceR, nonceA, TRANSCRIPT)
    expect(code).toMatch(/^\d{3} \d{3}$/)
    expect(await displayedSasCode(nonceR.slice(), nonceA.slice(), { ...TRANSCRIPT })).toBe(code)
  })

  it("wipes a nonce in place", () => {
    const nonce = newApproverNonce()
    wipeNonce(nonce)
    expect(nonce.every((byte) => byte === 0)).toBe(true)
  })
})
