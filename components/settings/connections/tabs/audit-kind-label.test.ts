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

describe("audit kind coverage for the lark dual-entry kinds", () => {
  it("has a translated label for every kind this epic emits", async () => {
    const en = (await import("@/i18n/messages/en.json")).default as Record<string, unknown>
    const zh = (await import("@/i18n/messages/zh-CN.json")).default as Record<string, unknown>
    const read = (bundle: Record<string, unknown>, path: string): unknown =>
      path
        .split(".")
        .reduce<unknown>(
          (node, key) =>
            node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined,
          bundle
        )

    // The Audit tab filter is how the runbook decides whether callback
    // enforcement is safe to widen; raw enum strings there make that unusable.
    const kinds = [
      "principal.unbound",
      "principal.rejected",
      "principal.bind_requested",
      "principal.bound",
      "principal.bind_rejected",
      "principal.status_changed",
      "principal.rebound",
      "tenant.registered",
      "tenant.status_changed",
      "callback.forbidden",
      "callback.authorization_would_deny",
      "menu.unknown_key",
      "chat_tab.synced",
      "chat_tab.sync_failed",
      "chat_tab.removed",
      "shortcut.import",
      "shortcut.import_denied",
      "plus.create",
      "plus.create_denied",
      "sso.session_seen",
      "entry.consumed",
      "entry.denied",
    ]
    for (const kind of kinds) {
      const path = `settings.connections.audit.kind.${kind}`
      expect(typeof read(en, path)).toBe("string")
      expect(typeof read(zh, path)).toBe("string")
    }
  })
})
