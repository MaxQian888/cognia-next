import { buildWebhookSignatureHeader, signWebhookBody } from "./webhook-signature"

// Reference vector: HMAC-SHA256 of body "hello" with key "secret".
// Computed via `python -c "import hmac, hashlib; print(hmac.new(b'secret', b'hello', hashlib.sha256).hexdigest())"`.
const HELLO_SECRET_HEX = "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b"

describe("signWebhookBody", () => {
  it("matches the canonical HMAC-SHA256 vector for hello/secret", async () => {
    const sig = await signWebhookBody("hello", "secret")
    expect(sig).toBe(HELLO_SECRET_HEX)
  })

  it("returns 64 lowercase hex characters", async () => {
    const sig = await signWebhookBody('{"foo":"bar"}', "long-secret-with-symbols-!@#$%^&*()")
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
  })

  it("produces a different digest when the secret changes", async () => {
    const a = await signWebhookBody("body", "secret-a")
    const b = await signWebhookBody("body", "secret-b")
    expect(a).not.toBe(b)
  })

  it("produces a different digest when the body changes", async () => {
    const a = await signWebhookBody("body-a", "secret")
    const b = await signWebhookBody("body-b", "secret")
    expect(a).not.toBe(b)
  })

  it("handles empty body", async () => {
    const sig = await signWebhookBody("", "secret")
    // python: hmac.new(b'secret', b'', hashlib.sha256).hexdigest()
    expect(sig).toBe("f9e66e179b6747ae54108f82f8ade8b3c25d76fd30afde6c395822c530196169")
  })

  it("handles non-ASCII body (UTF-8 encoded)", async () => {
    const sig = await signWebhookBody("你好", "secret")
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
  })

  it("rejects an empty secret", async () => {
    await expect(signWebhookBody("body", "")).rejects.toThrow(/secret is required/)
  })
})

describe("buildWebhookSignatureHeader", () => {
  it("formats as sha256=<hex>", async () => {
    const header = await buildWebhookSignatureHeader("hello", "secret")
    expect(header).toBe(`sha256=${HELLO_SECRET_HEX}`)
  })
})
