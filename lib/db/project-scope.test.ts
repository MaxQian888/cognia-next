/** @jest-environment jsdom */
import "fake-indexeddb/auto"

// The cascade dynamically imports the project-knowledge deps resolver for its
// best-effort remote vector-collection drop. Mock it so tests control whether a
// (fake) vector store is present.
jest.mock("@/lib/project-knowledge/runtime/build-deps", () => ({
  tryBuildProjectKnowledgeDeps: jest.fn(async () => undefined),
}))

import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import { getSettings, saveSettings } from "./settings"
import { tryBuildProjectKnowledgeDeps } from "@/lib/project-knowledge/runtime/build-deps"

const projectDepsMock = tryBuildProjectKnowledgeDeps as jest.Mock
import {
  deleteProjectCascade,
  ensureDefaultProject,
  resolveScopeProjectId,
  resolveSessionProjectId,
  scopedWhere,
  DEFAULT_PROJECT_ID,
} from "./project-scope"

describe("project-scope helper", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    // Let the background built-in seed settle before exercising heavy
    // multi-table cascades, so seeding transactions don't race the test.
    getDb()
    await whenSeeded()
  }, 30000)

  describe("resolveScopeProjectId", () => {
    it("returns an explicit id verbatim without touching settings", async () => {
      expect(await resolveScopeProjectId("proj-explicit")).toBe("proj-explicit")
      // No Default was auto-created.
      expect(await getDb().projects.get(DEFAULT_PROJECT_ID)).toBeUndefined()
    })

    it("returns the persisted active project id when set", async () => {
      await saveSettings({ activeProjectId: "proj-active" })
      expect(await resolveScopeProjectId()).toBe("proj-active")
    })

    it("auto-creates + activates a Default workspace when none is active", async () => {
      const id = await resolveScopeProjectId()
      expect(id).toBe(DEFAULT_PROJECT_ID)
      expect(await getDb().projects.get(DEFAULT_PROJECT_ID)).toBeDefined()
      expect((await getSettings()).activeProjectId).toBe(DEFAULT_PROJECT_ID)
    })
  })

  describe("ensureDefaultProject", () => {
    it("is idempotent — a second call returns the same row, no duplicate", async () => {
      const a = await ensureDefaultProject()
      const b = await ensureDefaultProject()
      expect(a.id).toBe(b.id)
      expect(await getDb().projects.count()).toBe(1)
    })

    it("re-activates the Default when it exists but the active pointer was cleared", async () => {
      await ensureDefaultProject()
      await saveSettings({ activeProjectId: null })
      const again = await ensureDefaultProject()
      expect(again.id).toBe(DEFAULT_PROJECT_ID)
      expect((await getSettings()).activeProjectId).toBe(DEFAULT_PROJECT_ID)
    })
  })

  describe("resolveSessionProjectId", () => {
    it("returns the session's own projectId", async () => {
      await getDb().sessions.put({
        id: "s1",
        projectId: "proj-A",
        title: "a",
        updatedAt: 1,
        createdAt: 1,
      } as never)
      expect(await resolveSessionProjectId("s1")).toBe("proj-A")
    })

    it("prefers an explicit override over the session lookup", async () => {
      expect(await resolveSessionProjectId("s1", "proj-forced")).toBe("proj-forced")
    })

    it("falls back to the active project for an unknown session", async () => {
      await saveSettings({ activeProjectId: "proj-active" })
      expect(await resolveSessionProjectId("ghost")).toBe("proj-active")
    })
  })

  describe("scopedWhere", () => {
    it("filters a table to one workspace", async () => {
      const db = getDb()
      await db.sessions.bulkPut([
        { id: "s1", projectId: "A", title: "a", updatedAt: 1, createdAt: 1 },
        { id: "s2", projectId: "B", title: "b", updatedAt: 2, createdAt: 2 },
      ] as never)
      const rows = await scopedWhere(db.sessions, "A").toArray()
      expect(rows.map((r) => r.id)).toEqual(["s1"])
    })
  })

  describe("deleteProjectCascade", () => {
    it("removes every scoped row + session-child row for the project, leaving others intact", async () => {
      const db = getDb()
      // Project A data.
      await db.sessions.bulkPut([
        { id: "sA", projectId: "A", title: "a", updatedAt: 1, createdAt: 1 },
        { id: "sB", projectId: "B", title: "b", updatedAt: 1, createdAt: 1 },
      ] as never)
      await db.messages.bulkPut([
        { id: "mA", sessionId: "sA", projectId: "A", role: "user", parts: [], createdAt: 1 },
        { id: "mB", sessionId: "sB", projectId: "B", role: "user", parts: [], createdAt: 1 },
      ] as never)
      await db.chatGoals.bulkPut([
        { id: "gA", sessionId: "sA", projectId: "A", status: "active", createdAt: 1, updatedAt: 1 },
        { id: "gB", sessionId: "sB", projectId: "B", status: "active", createdAt: 1, updatedAt: 1 },
      ] as never)
      // Goal events — NO projectId column (dropped by parent goalId).
      await db.chatGoalEvents.bulkPut([
        { id: "geA", goalId: "gA", kind: "created", ts: 1 },
        { id: "geB", goalId: "gB", kind: "created", ts: 1 },
      ] as never)
      // Canvas doc + version — version dropped by parent documentId.
      await db.canvasDocuments.bulkPut([
        {
          id: "dA",
          projectId: "A",
          title: "a",
          content: "",
          language: "ts",
          type: "code",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "dB",
          projectId: "B",
          title: "b",
          content: "",
          language: "ts",
          type: "code",
          createdAt: 1,
          updatedAt: 1,
        },
      ] as never)
      await db.canvasVersions.bulkPut([
        { id: "vA", documentId: "dA", content: "", title: "a", createdAt: 1 },
        { id: "vB", documentId: "dB", content: "", title: "b", createdAt: 1 },
      ] as never)
      // Session-child row (no projectId column) — must be dropped via sessionId.
      await db.sessionUsage.bulkPut([
        { messageId: "mA", sessionId: "sA", at: 1 },
        { messageId: "mB", sessionId: "sB", at: 1 },
      ] as never)
      // Project-scoped RAG chunks (v100) — dropped by projectId.
      await db.projectChunks.bulkPut([
        {
          id: "pcA",
          projectId: "A",
          fileId: "f",
          vectorDocId: "A__f__0",
          content: "",
          contentRedacted: "",
          charStart: 0,
          charEnd: 0,
          vectorBackend: "native",
          vectorCollection: "cognia_project_A",
          strategy: "paragraph",
          tokenCount: 1,
          metadata: {},
          contentHash: "h",
          createdAt: 1,
        },
        {
          id: "pcB",
          projectId: "B",
          fileId: "f",
          vectorDocId: "B__f__0",
          content: "",
          contentRedacted: "",
          charStart: 0,
          charEnd: 0,
          vectorBackend: "native",
          vectorCollection: "cognia_project_B",
          strategy: "paragraph",
          tokenCount: 1,
          metadata: {},
          contentHash: "h",
          createdAt: 1,
        },
      ] as never)

      await deleteProjectCascade("A")

      expect(await db.projectChunks.get("pcA")).toBeUndefined()
      expect(await db.projectChunks.get("pcB")).toBeDefined()
      expect(await db.sessions.get("sA")).toBeUndefined()
      expect(await db.messages.get("mA")).toBeUndefined()
      expect(await db.chatGoals.get("gA")).toBeUndefined()
      expect(await db.chatGoalEvents.get("geA")).toBeUndefined()
      expect(await db.canvasDocuments.get("dA")).toBeUndefined()
      expect(await db.canvasVersions.get("vA")).toBeUndefined()
      expect(await db.sessionUsage.get("mA")).toBeUndefined()
      // Project B is untouched.
      expect(await db.sessions.get("sB")).toBeDefined()
      expect(await db.messages.get("mB")).toBeDefined()
      expect(await db.chatGoals.get("gB")).toBeDefined()
      expect(await db.chatGoalEvents.get("geB")).toBeDefined()
      expect(await db.canvasDocuments.get("dB")).toBeDefined()
      expect(await db.canvasVersions.get("vB")).toBeDefined()
      expect(await db.sessionUsage.get("mB")).toBeDefined()
    }, 30000)

    it("is a no-op for a project with no data", async () => {
      await expect(deleteProjectCascade("empty")).resolves.toBeUndefined()
    }, 30000)

    it("drops the remote vector collection best-effort when a backend exists", async () => {
      const deleteCollection = jest.fn(async () => undefined)
      projectDepsMock.mockResolvedValueOnce({ store: { deleteCollection } })
      await deleteProjectCascade("A")
      expect(deleteCollection).toHaveBeenCalledWith("cognia_project_A")
    }, 30000)

    it("does not throw when the remote collection drop fails", async () => {
      const deleteCollection = jest.fn(async () => {
        throw new Error("remote down")
      })
      projectDepsMock.mockResolvedValueOnce({ store: { deleteCollection } })
      const db = getDb()
      await db.projectChunks.put({
        id: "pc",
        projectId: "A",
        fileId: "f",
        vectorDocId: "A__f__0",
        content: "",
        contentRedacted: "",
        charStart: 0,
        charEnd: 0,
        vectorBackend: "native",
        vectorCollection: "cognia_project_A",
        strategy: "paragraph",
        tokenCount: 1,
        metadata: {},
        contentHash: "h",
        createdAt: 1,
      } as never)
      await expect(deleteProjectCascade("A")).resolves.toBeUndefined()
      // Local rows are still dropped despite the remote failure.
      expect(await db.projectChunks.get("pc")).toBeUndefined()
    }, 30000)
  })
})
