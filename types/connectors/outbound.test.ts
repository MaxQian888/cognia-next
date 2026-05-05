import { newIdempotencyKey, type OutboundRequest, type OutboundResult } from "./outbound"

describe("outbound", () => {
  it("idempotency keys are unique", () => {
    const a = newIdempotencyKey()
    const b = newIdempotencyKey()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("OutboundResult error shape compiles", () => {
    const r: OutboundResult = {
      ok: false,
      error: { code: "rate_limited", message: "429", retryable: true },
    }
    expect(r.ok).toBe(false)
  })

  it("OutboundRequest with minimal fields compiles", () => {
    const req: OutboundRequest = {
      conversationRef: { platform: "telegram", adapterId: "x" },
      segments: [{ type: "text", text: "hi" }],
      metadata: { idempotencyKey: newIdempotencyKey() },
    }
    expect(req.segments).toHaveLength(1)
  })
})
