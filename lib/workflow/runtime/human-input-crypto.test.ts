import { openHumanInputValues, sealHumanInputValues } from "./human-input-crypto"

const key = new Uint8Array(32).fill(7)
const scope = { accountId: "account_1", requestId: "request_1", responderId: "member_1" }
const deps = { loadKey: async () => key }

describe("human-input-crypto", () => {
  it("round-trips sensitive values while keeping plaintext out of the envelope", async () => {
    const envelope = await sealHumanInputValues({ secret: "private", pin: 1234 }, scope, deps)
    expect(JSON.stringify(envelope)).not.toContain("private")
    await expect(openHumanInputValues(envelope, scope, deps)).resolves.toEqual({
      secret: "private",
      pin: 1234,
    })
  })

  it("binds ciphertext to account, request, and responder", async () => {
    const envelope = await sealHumanInputValues({ secret: "private" }, scope, deps)
    await expect(
      openHumanInputValues(envelope, { ...scope, responderId: "member_2" }, deps)
    ).rejects.toThrow()
  })
})
