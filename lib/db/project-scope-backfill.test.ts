import "fake-indexeddb/auto"
import Dexie from "dexie"
import { backfillProjectScopeV86 } from "./project-scope-backfill"
import { DEFAULT_PROJECT_ID } from "./project-defaults"

/**
 * Minimal Dexie carrying only the tables the backfill touches, with primary
 * keys + the foreign keys it derives from. Lets us exercise the (error-prone)
 * upgrade attribution in isolation, without the full production schema or seeder.
 */
function makeDb(name: string): Dexie {
  const db = new Dexie(name)
  db.version(1).stores({
    projects: "&id",
    settings: "&id",
    sessions: "&id",
    messages: "&id, sessionId",
    chatGoals: "&id, sessionId",
    chatGoalEvents: "&id, goalId",
    agentPlans: "&id, sessionId",
    agentPlanEvents: "&id, planId",
    loops: "&id, sessionId",
    loopEvents: "&id, loopId",
    agentTraces: "&id, sessionId",
    canvasDocuments: "&id",
    canvasVersions: "&id, documentId",
    canvasComments: "&id, documentId",
    canvasSessions: "&id, documentId",
    workflowRuns: "&id",
    workflowRunEvents: "&id, runId",
    outboundQueue: "&id",
    connectorDrafts: "&id, sessionId",
    connectorAudit: "&id",
    conversationOverrides: "&id, sessionId",
  })
  return db
}

async function runBackfill(db: Dexie): Promise<void> {
  await db.transaction("rw", db.tables, async (tx) => {
    await backfillProjectScopeV86(tx)
  })
}

describe("backfillProjectScopeV86", () => {
  let db: Dexie
  let counter = 0

  beforeEach(() => {
    db = makeDb(`backfill-${counter++}`)
  })

  afterEach(async () => {
    await db.delete()
  })

  it("attributes rows via the legacy sessionIds[] reverse map, falling back to the active project", async () => {
    await db.open()
    // Two projects, active = A. A owns s1, B owns s2. s3 is referenced by neither.
    await db.table("projects").bulkPut([
      { id: "A", sessionIds: ["s1"] },
      { id: "B", sessionIds: ["s2"] },
    ])
    await db.table("settings").put({ id: "singleton", activeProjectId: "A" })
    await db.table("sessions").bulkPut([{ id: "s1" }, { id: "s2" }, { id: "s3" }])
    await db.table("messages").bulkPut([
      { id: "m1", sessionId: "s1" },
      { id: "m2", sessionId: "s2" },
      { id: "m3", sessionId: "s3" },
    ])
    await db.table("chatGoals").put({ id: "g1", sessionId: "s1" })
    await db.table("chatGoalEvents").put({ id: "ge1", goalId: "g1" })
    await db.table("canvasDocuments").put({ id: "c1" })
    await db.table("canvasVersions").put({ id: "cv1", documentId: "c1" })
    await db.table("workflowRuns").put({ id: "wr1" })
    await db.table("workflowRunEvents").put({ id: "wre1", runId: "wr1" })
    await db.table("outboundQueue").put({ id: "oq1" })
    await db.table("connectorAudit").put({ id: "ca1" })
    await db.table("conversationOverrides").put({ id: "co1", sessionId: "s2" })
    await db.table("connectorDrafts").put({ id: "cd1", sessionId: "s1" })

    await runBackfill(db)

    const pid = async (table: string, id: string) => (await db.table(table).get(id))?.projectId

    // Sessions: reverse map wins; orphan s3 → fallback active (A).
    expect(await pid("sessions", "s1")).toBe("A")
    expect(await pid("sessions", "s2")).toBe("B")
    expect(await pid("sessions", "s3")).toBe("A")
    // Messages inherit their session's project.
    expect(await pid("messages", "m1")).toBe("A")
    expect(await pid("messages", "m2")).toBe("B")
    expect(await pid("messages", "m3")).toBe("A")
    // Goal + its event (event inherits parent goal's project).
    expect(await pid("chatGoals", "g1")).toBe("A")
    expect(await pid("chatGoalEvents", "ge1")).toBe("A")
    // Canvas doc (no session) → fallback; version inherits the doc.
    expect(await pid("canvasDocuments", "c1")).toBe("A")
    expect(await pid("canvasVersions", "cv1")).toBe("A")
    // Workflow run (no session) → fallback; event inherits the run.
    expect(await pid("workflowRuns", "wr1")).toBe("A")
    expect(await pid("workflowRunEvents", "wre1")).toBe("A")
    // Linkage-free routing rows → fallback.
    expect(await pid("outboundQueue", "oq1")).toBe("A")
    expect(await pid("connectorAudit", "ca1")).toBe("A")
    // Session-linked routing rows → derived from the session's owner.
    expect(await pid("conversationOverrides", "co1")).toBe("B")
    expect(await pid("connectorDrafts", "cd1")).toBe("A")
  })

  it("creates + activates a Default workspace when none is active and none exist", async () => {
    await db.open()
    await db.table("sessions").bulkPut([{ id: "s1" }, { id: "s2" }])
    await db.table("messages").put({ id: "m1", sessionId: "s1" })

    await runBackfill(db)

    const def = await db.table("projects").get(DEFAULT_PROJECT_ID)
    expect(def?.name).toBe("Default")
    const settings = await db.table("settings").get("singleton")
    expect(settings?.activeProjectId).toBe(DEFAULT_PROJECT_ID)
    expect((await db.table("sessions").get("s1"))?.projectId).toBe(DEFAULT_PROJECT_ID)
    expect((await db.table("sessions").get("s2"))?.projectId).toBe(DEFAULT_PROJECT_ID)
    expect((await db.table("messages").get("m1"))?.projectId).toBe(DEFAULT_PROJECT_ID)
  })

  it("preserves a settings row that lacks an activeProjectId by adding Default", async () => {
    await db.open()
    await db.table("settings").put({ id: "singleton", theme: "dark" })
    await db.table("sessions").put({ id: "s1" })

    await runBackfill(db)

    const settings = await db.table("settings").get("singleton")
    expect(settings?.theme).toBe("dark")
    expect(settings?.activeProjectId).toBe(DEFAULT_PROJECT_ID)
  })

  it("is idempotent — rows that already carry projectId are left untouched", async () => {
    await db.open()
    await db.table("projects").put({ id: "A", sessionIds: ["s1"] })
    await db.table("settings").put({ id: "singleton", activeProjectId: "A" })
    await db.table("sessions").put({ id: "s1", projectId: "MANUAL" })

    await runBackfill(db)
    await runBackfill(db)

    expect((await db.table("sessions").get("s1"))?.projectId).toBe("MANUAL")
  })
})
