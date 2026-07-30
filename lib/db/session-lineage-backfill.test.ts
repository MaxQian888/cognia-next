/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie from "dexie"
import type { SessionSurfaceBinding } from "@cognia/agent-config-types"
import { backfillSessionLineageV131, bindingKeyForBackfill } from "./session-lineage-backfill"
import { surfaceBindingKey } from "@/lib/context-workbench/resource-session"
import { DEFAULT_PROJECT_ID } from "./project-defaults"

/**
 * Minimal Dexie carrying only the tables the backfill touches. Mirrors
 * `project-scope-backfill.test.ts` — exercises the attribution rules without
 * the full production schema or seeder.
 */
function makeDb(name: string): Dexie {
  const db = new Dexie(name)
  db.version(1).stores({
    projects: "&id",
    settings: "&id",
    sessions: "&id",
    messages: "&id, sessionId",
  })
  return db
}

async function runBackfill(db: Dexie): Promise<void> {
  await db.transaction("rw", db.tables, async (tx) => {
    await backfillSessionLineageV131(tx)
  })
}

const sessionRows = (db: Dexie) =>
  db.table("sessions").toArray() as Promise<Array<Record<string, unknown>>>

async function projectIdOf(db: Dexie, id: string): Promise<unknown> {
  const row = (await db.table("sessions").get(id)) as Record<string, unknown> | undefined
  return row?.projectId
}

describe("backfillSessionLineageV131", () => {
  let db: Dexie
  let counter = 0

  beforeEach(() => {
    db = makeDb(`lineage-backfill-${counter++}`)
  })

  afterEach(async () => {
    await db.delete()
  })

  it("files a branch in its parent's workspace, not the active one", async () => {
    await db.open()
    await db.table("projects").bulkPut([{ id: "p_a" }, { id: "p_b" }])
    await db.table("settings").put({ id: "singleton", activeProjectId: "p_b" })
    await db.table("sessions").bulkPut([
      { id: "s_parent", title: "parent", projectId: "p_a", createdAt: 1, updatedAt: 1 },
      // The orphan: written by `buildChildRow`, which omitted projectId.
      {
        id: "s_branch",
        title: "parent (branch)",
        parentSessionId: "s_parent",
        createdAt: 2,
        updatedAt: 2,
      },
    ])

    await runBackfill(db)

    expect(await projectIdOf(db, "s_branch")).toBe("p_a")
  })

  it("files a sidechat in the workspace of the conversation it is an aside to", async () => {
    await db.open()
    await db.table("projects").bulkPut([{ id: "p_a" }, { id: "p_b" }])
    await db.table("settings").put({ id: "singleton", activeProjectId: "p_b" })
    await db.table("sessions").bulkPut([
      { id: "s_main", title: "main", projectId: "p_a", createdAt: 1, updatedAt: 1 },
      {
        id: "resource-workbench:session:s_main",
        title: "aside",
        kind: "resource-workbench",
        visibility: "embedded",
        surfaceBinding: { kind: "session", sessionId: "s_main" },
        createdAt: 2,
        updatedAt: 2,
      },
    ])

    await runBackfill(db)

    expect(await projectIdOf(db, "resource-workbench:session:s_main")).toBe("p_a")
  })

  it("follows a chain of unstamped ancestors rather than stopping at the first hop", async () => {
    // A branch of a branch, and an aside of that — every intermediate is an
    // orphan too, so a single-hop resolve would drop the tail on the fallback.
    await db.open()
    await db.table("projects").bulkPut([{ id: "p_a" }, { id: "p_fallback" }])
    await db.table("settings").put({ id: "singleton", activeProjectId: "p_fallback" })
    await db.table("sessions").bulkPut([
      { id: "s_root", title: "root", projectId: "p_a", createdAt: 1, updatedAt: 1 },
      { id: "s_b1", title: "b1", parentSessionId: "s_root", createdAt: 2, updatedAt: 2 },
      { id: "s_b2", title: "b2", parentSessionId: "s_b1", createdAt: 3, updatedAt: 3 },
      {
        id: "resource-workbench:session:s_b2",
        title: "aside of b2",
        kind: "resource-workbench",
        surfaceBinding: { kind: "session", sessionId: "s_b2" },
        createdAt: 4,
        updatedAt: 4,
      },
    ])

    await runBackfill(db)

    expect(await projectIdOf(db, "s_b1")).toBe("p_a")
    expect(await projectIdOf(db, "s_b2")).toBe("p_a")
    expect(await projectIdOf(db, "resource-workbench:session:s_b2")).toBe("p_a")
  })

  it("terminates on a lineage cycle instead of hanging", async () => {
    // `parentSessionId` has never been validated on write; a self-referencing
    // or looped row must not spin the upgrade forever.
    await db.open()
    await db.table("projects").put({ id: "p_a" })
    await db.table("settings").put({ id: "singleton", activeProjectId: "p_a" })
    await db.table("sessions").bulkPut([
      { id: "s_x", title: "x", parentSessionId: "s_y", createdAt: 1, updatedAt: 1 },
      { id: "s_y", title: "y", parentSessionId: "s_x", createdAt: 2, updatedAt: 2 },
      { id: "s_self", title: "self", parentSessionId: "s_self", createdAt: 3, updatedAt: 3 },
    ])

    await runBackfill(db)

    expect(await projectIdOf(db, "s_x")).toBe("p_a")
    expect(await projectIdOf(db, "s_y")).toBe("p_a")
    expect(await projectIdOf(db, "s_self")).toBe("p_a")
  })

  it("falls back when the parent was deleted, and creates a Default workspace when none is active", async () => {
    await db.open()
    await db.table("sessions").put({
      id: "s_orphan",
      title: "dangling",
      parentSessionId: "s_long_gone",
      createdAt: 1,
      updatedAt: 1,
    })

    await runBackfill(db)

    expect(await projectIdOf(db, "s_orphan")).toBe(DEFAULT_PROJECT_ID)
    const settings = (await db.table("settings").get("singleton")) as Record<string, unknown>
    expect(settings.activeProjectId).toBe(DEFAULT_PROJECT_ID)
  })

  it("propagates the rescued workspace onto the session's messages", async () => {
    await db.open()
    await db.table("projects").put({ id: "p_a" })
    await db.table("settings").put({ id: "singleton", activeProjectId: "p_a" })
    await db.table("sessions").bulkPut([
      { id: "s_parent", title: "parent", projectId: "p_a", createdAt: 1, updatedAt: 1 },
      { id: "s_branch", title: "branch", parentSessionId: "s_parent", createdAt: 2, updatedAt: 2 },
    ])
    await db.table("messages").bulkPut([
      { id: "m1", sessionId: "s_branch", createdAt: 2 },
      // Already stamped — must not be rewritten.
      { id: "m2", sessionId: "s_branch", projectId: "p_untouched", createdAt: 3 },
    ])

    await runBackfill(db)

    const rows = (await db.table("messages").toArray()) as Array<Record<string, unknown>>
    expect(rows.find((r) => r.id === "m1")?.projectId).toBe("p_a")
    expect(rows.find((r) => r.id === "m2")?.projectId).toBe("p_untouched")
  })

  it("stamps surfaceBindingKey on every bound row and leaves unbound rows alone", async () => {
    await db.open()
    await db.table("projects").put({ id: "p_a" })
    await db.table("settings").put({ id: "singleton", activeProjectId: "p_a" })
    await db.table("sessions").bulkPut([
      { id: "s_plain", title: "plain", projectId: "p_a", createdAt: 1, updatedAt: 1 },
      {
        id: "s_artifact",
        title: "artifact aside",
        projectId: "p_a",
        surfaceBinding: { kind: "artifact", artifactId: "a1" },
        createdAt: 2,
        updatedAt: 2,
      },
    ])

    await runBackfill(db)

    const rows = await sessionRows(db)
    expect(rows.find((r) => r.id === "s_artifact")?.surfaceBindingKey).toBe("artifact:a1")
    expect(rows.find((r) => r.id === "s_plain")?.surfaceBindingKey).toBeUndefined()
  })

  it("is a no-op over an already-migrated database", async () => {
    await db.open()
    await db.table("projects").put({ id: "p_a" })
    await db.table("settings").put({ id: "singleton", activeProjectId: "p_a" })
    await db.table("sessions").put({
      id: "s_done",
      title: "done",
      projectId: "p_keep",
      surfaceBinding: { kind: "artifact", artifactId: "a1" },
      surfaceBindingKey: "artifact:a1",
      createdAt: 1,
      updatedAt: 1,
    })

    await runBackfill(db)
    await runBackfill(db)

    expect(await projectIdOf(db, "s_done")).toBe("p_keep")
    // No workspace was invented for a database that needed no repair.
    expect(await db.table("projects").count()).toBe(1)
  })
})

describe("bindingKeyForBackfill", () => {
  // The migration deliberately carries its own copy of the key format so a
  // later change to the live helper cannot silently re-key historical rows.
  // This pins the two together for as long as they are meant to agree — if it
  // fails, the live format changed and the migration copy must stay frozen.
  const cases: SessionSurfaceBinding[] = [
    { kind: "canvas-document", documentId: "d1" },
    { kind: "project-file", projectId: "p1", rootId: "r1", relPath: "src/a b.ts" },
    { kind: "artifact", artifactId: "a1" },
    { kind: "workflow", workflowId: "w1" },
    { kind: "session", sessionId: "s1" },
  ]

  it.each(cases)("matches the live surfaceBindingKey for %j", (binding) => {
    expect(bindingKeyForBackfill(binding)).toBe(surfaceBindingKey(binding))
  })

  it("percent-encodes separators so a path cannot forge a key boundary", () => {
    expect(
      bindingKeyForBackfill({ kind: "project-file", projectId: "p", rootId: "r", relPath: "a:b" })
    ).toBe("project:p:r:a%3Ab")
  })
})
