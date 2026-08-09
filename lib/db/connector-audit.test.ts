import {
  append,
  listRecent,
  sweepConnectorAuditRetention,
  CONNECTOR_AUDIT_SECURITY_RETENTION_MS,
  CONNECTOR_AUDIT_OPERATIONAL_RETENTION_MS,
  CONNECTOR_AUDIT_DIAGNOSTIC_RETENTION_MS,
} from "./connector-audit"
import type { AuditEntry } from "@/types/connectors/audit"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function makeEntry(overrides: Partial<AuditEntry> = {}): Omit<AuditEntry, "id"> {
  return {
    adapterId: overrides.adapterId ?? "adp_1",
    kind: overrides.kind ?? "inbound.received",
    at: overrides.at ?? Date.now(),
    conversationKey: overrides.conversationKey,
    reason: overrides.reason,
    message: overrides.message,
    fields: overrides.fields,
  }
}

describe("connector-audit", () => {
  it("appends rows and lists them newest-first with adapter filtering", async () => {
    await append({ id: "a1", ...makeEntry({ adapterId: "adp_1", at: 100 }) })
    await append({ id: "b1", ...makeEntry({ adapterId: "adp_2", at: 200 }) })
    const generated = await append(makeEntry({ adapterId: "adp_1", at: 300 }))

    expect(generated.id).toEqual(expect.any(String))
    expect((await listRecent()).map((row) => row.at)).toEqual([300, 200, 100])
    expect((await listRecent("adp_1", 1)).map((row) => row.at)).toEqual([300])
  })

  it("retains security evidence longer than high-volume diagnostics", async () => {
    const day = 24 * 60 * 60 * 1_000
    const now = 40 * day
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        append({
          id: `diag-${index}`,
          ...makeEntry({ kind: "inbound.received", at: now - 10 * day }),
        })
      )
    )
    await append({
      id: "security-young",
      ...makeEntry({ kind: "callback.forbidden", at: now - 20 * day }),
    })
    await append({
      id: "security-old",
      ...makeEntry({
        kind: "delivery.error",
        reason: "delivery_unknown",
        at: now - CONNECTOR_AUDIT_SECURITY_RETENTION_MS - 1,
      }),
    })
    await append({
      id: "operational-old",
      ...makeEntry({
        kind: "adapter.started",
        at: now - CONNECTOR_AUDIT_OPERATIONAL_RETENTION_MS - 1,
      }),
    })

    await sweepConnectorAuditRetention({ now, batchLimit: 60 })

    expect(await getDb().connectorAudit.get("security-young")).toBeDefined()
    expect(await getDb().connectorAudit.get("security-old")).toBeUndefined()
    expect(await getDb().connectorAudit.get("operational-old")).toBeUndefined()
    expect(
      await getDb()
        .connectorAudit.where("at")
        .below(now - CONNECTOR_AUDIT_DIAGNOSTIC_RETENTION_MS)
        .count()
    ).toBe(11)
  })

  it("caps work per sweep while giving every retention tier a quota", async () => {
    const now = 100 * 24 * 60 * 60 * 1_000
    for (let index = 0; index < 12; index++) {
      await append({
        id: `old-${index}`,
        ...makeEntry({ kind: "inbound.received", at: 1 }),
      })
    }
    await expect(sweepConnectorAuditRetention({ now, batchLimit: 3 })).resolves.toBe(1)
    expect(await getDb().connectorAudit.count()).toBe(11)
  })
})
