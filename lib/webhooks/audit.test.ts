import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { appendWebhookAudit, listWebhookAudit, pruneWebhookAudit } from "./audit"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("webhook audit", () => {
  it("appends and lists outbound deliveries newest-first", async () => {
    await appendWebhookAudit({
      direction: "outbound",
      kind: "outbound.delivered",
      endpointId: "ep_1",
      result: "delivered",
      at: 1000,
    })
    await appendWebhookAudit({
      direction: "outbound",
      kind: "outbound.failed",
      endpointId: "ep_2",
      result: "failed",
      at: 2000,
    })
    const rows = await listWebhookAudit(10)
    expect(rows.map((row) => row.endpointId)).toEqual(["ep_2", "ep_1"])
  })

  it("defaults id and timestamp", async () => {
    await appendWebhookAudit({
      direction: "outbound",
      kind: "outbound.delivered",
      result: "delivered",
    })
    const [row] = await listWebhookAudit()
    expect(row.id).toMatch(/.+/)
    expect(row.at).toBeGreaterThan(0)
  })

  it("does not expose retained inbound legacy rows", async () => {
    await getDb().remoteControlAudit.add({
      id: "legacy",
      at: 1,
      direction: "inbound",
      kind: "inbound.command",
    } as never)
    expect(await listWebhookAudit()).toEqual([])
  })

  it("prunes the oldest rows beyond the cap", async () => {
    const table = getDb().remoteControlAudit
    await table.bulkAdd(
      Array.from({ length: 1005 }, (_, index) => ({
        id: `id_${index}`,
        at: index,
        direction: "outbound" as const,
        kind: "outbound.delivered" as const,
        result: "delivered" as const,
      }))
    )
    await pruneWebhookAudit()
    expect(await table.count()).toBe(1000)
    expect((await table.orderBy("at").first())?.at).toBe(5)
  })
})
