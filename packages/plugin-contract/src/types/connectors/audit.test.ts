import { auditDeliveryError, type AuditEntry } from "./audit"

describe("audit", () => {
  it("auditDeliveryError builds a typed entry", () => {
    const e = auditDeliveryError({
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:1",
      idempotencyKey: "abc",
      reason: "rate_limited",
      message: "429",
    })
    expect(e.kind).toBe("delivery.error")
    expect(e.adapterId).toBe("tg-1")
  })

  it("kind union covers the ship-set", () => {
    const e: AuditEntry = {
      id: "1",
      adapterId: "x",
      kind: "circuit.opened",
      at: 0,
    }
    expect(e.kind).toBe("circuit.opened")
  })
})
