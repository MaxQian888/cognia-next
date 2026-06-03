import { signStandardWebhook, buildSignedHeaders } from "./signing"

describe("standard webhooks signing", () => {
  it("signs {id}.{timestamp}.{body} deterministically (base64)", async () => {
    const sig = await signStandardWebhook("msg_1", 1700000000, '{"a":1}', "whsec_test")
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/)
    const again = await signStandardWebhook("msg_1", 1700000000, '{"a":1}', "whsec_test")
    expect(again).toBe(sig)
  })

  it("changes signature when any signed component changes", async () => {
    const base = await signStandardWebhook("msg_1", 1700000000, '{"a":1}', "whsec_test")
    expect(await signStandardWebhook("msg_2", 1700000000, '{"a":1}', "whsec_test")).not.toBe(base)
    expect(await signStandardWebhook("msg_1", 1700000001, '{"a":1}', "whsec_test")).not.toBe(base)
    expect(await signStandardWebhook("msg_1", 1700000000, '{"a":2}', "whsec_test")).not.toBe(base)
    expect(await signStandardWebhook("msg_1", 1700000000, '{"a":1}', "whsec_other")).not.toBe(base)
  })

  it("builds the three-header set with a v1 signature", async () => {
    const h = await buildSignedHeaders("msg_1", 1700000000, '{"a":1}', "whsec_test")
    expect(h["webhook-id"]).toBe("msg_1")
    expect(h["webhook-timestamp"]).toBe("1700000000")
    expect(h["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/]+=*$/)
  })

  it("throws on empty secret", async () => {
    await expect(signStandardWebhook("m", 1, "b", "")).rejects.toThrow()
  })
})
