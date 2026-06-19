import { auditKindLabel, type AuditKindTranslator } from "./audit-kind-label"

/**
 * Build a fake next-intl translator scoped to a flat lookup map. The real
 * `t` is a callable with a `.has(key)` method; we mirror just that surface.
 */
function makeTranslator(map: Record<string, string>): AuditKindTranslator {
  const t = ((key: string) => map[key] ?? key) as unknown as AuditKindTranslator
  ;(t as unknown as { has: (k: string) => boolean }).has = (key: string) => key in map
  return t
}

describe("auditKindLabel", () => {
  it("returns the translated label for a mapped kind", () => {
    const t = makeTranslator({ "delivery.success": "Delivered" })
    expect(auditKindLabel(t, "delivery.success")).toBe("Delivered")
  })

  it("falls back to the raw kind when the key is missing", () => {
    const t = makeTranslator({})
    expect(auditKindLabel(t, "some.future.kind")).toBe("some.future.kind")
  })

  it("does not throw for an unmapped kind (guards the missing-key crash class)", () => {
    const t = makeTranslator({ "adapter.started": "Adapter started" })
    expect(() => auditKindLabel(t, "adapter.heartbeat")).not.toThrow()
    expect(auditKindLabel(t, "adapter.heartbeat")).toBe("adapter.heartbeat")
  })
})
