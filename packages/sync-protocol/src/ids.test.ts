import {
  isDeviceId,
  isRequestId,
  newDeviceId,
  newRequestId,
  SPACE_ID_PATTERN,
  spaceIdFor,
} from "./ids"

describe("ids", () => {
  it("mints dev_ and req_ ids from 16 random bytes", () => {
    const a = newDeviceId()
    expect(isDeviceId(a)).toBe(true)
    expect(isRequestId(newRequestId())).toBe(true)
    expect(newDeviceId()).not.toBe(a)
    expect(isDeviceId("dev_ILOU0000000000000000000000")).toBe(false)
    expect(isDeviceId(`req_${a.slice(4)}`)).toBe(false)
  })

  it("binds the space to the issuer and the subject", async () => {
    const sub = "usr_0123456789abcdef0123456789abcdef"
    const production = await spaceIdFor("https://id.cognia.cn/api/auth", sub)
    expect(production).toMatch(SPACE_ID_PATTERN)
    expect(await spaceIdFor("https://id.cognia.cn/api/auth", sub)).toBe(production)
    expect(await spaceIdFor("https://id-staging.cognia.cn/api/auth", sub)).not.toBe(production)
    // The separator keeps (iss, sub) pairs from colliding by concatenation.
    expect(await spaceIdFor("a", "bc")).not.toBe(await spaceIdFor("ab", "c"))
  })
})
