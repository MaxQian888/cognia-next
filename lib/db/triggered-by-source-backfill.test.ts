import "fake-indexeddb/auto"
import Dexie from "dexie"
import { backfillTriggeredBySourceV91 } from "./triggered-by-source-backfill"

describe("backfillTriggeredBySourceV91", () => {
  it("stamps triggeredBySource from triggeredBy.source, defaulting to ui", async () => {
    const db = new Dexie("backfill-v91-test-db")
    db.version(1).stores({ workflowRuns: "&id, triggeredBySource" })
    await db.open()
    await db.table("workflowRuns").bulkPut([
      { id: "im", triggeredBy: { source: "im", adapterId: "a", conversationKey: "c" } },
      { id: "api", triggeredBy: { source: "api" } },
      // Legacy run with no triggeredBy at all → defaults to "ui".
      { id: "legacy" },
      // Already stamped (idempotent re-run) → left untouched.
      { id: "already", triggeredBy: { source: "im" }, triggeredBySource: "ui" },
    ])

    await db.transaction("rw", "workflowRuns", async () => {
      const tx = Dexie.currentTransaction
      if (!tx) throw new Error("expected an active transaction")
      await backfillTriggeredBySourceV91(tx)
    })

    const get = async (id: string) =>
      (await db.table("workflowRuns").get(id)) as { triggeredBySource?: string }
    expect((await get("im")).triggeredBySource).toBe("im")
    expect((await get("api")).triggeredBySource).toBe("api")
    expect((await get("legacy")).triggeredBySource).toBe("ui")
    expect((await get("already")).triggeredBySource).toBe("ui")

    // The new index resolves only the IM-triggered run.
    const imRuns = await db
      .table("workflowRuns")
      .where("triggeredBySource")
      .equals("im")
      .primaryKeys()
    expect(imRuns).toEqual(["im"])

    db.close()
    await db.delete()
  })
})
