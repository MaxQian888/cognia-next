// The cascade dynamically imports the project-knowledge deps resolver for its
// best-effort remote vector-collection drop. Mock it so tests control whether a
// (fake) vector store is present.
jest.mock("@/lib/project-knowledge/runtime/build-deps", () => ({
  tryBuildProjectKnowledgeDeps: jest.fn(async () => undefined),
}))

const mockDeleteExternalSession = jest.fn().mockResolvedValue(undefined)
const mockAgentInvoke = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({
    deleteSession: (...args: unknown[]) => mockDeleteExternalSession(...args),
  }),
}))
jest.mock("@/lib/ai/agent/external/agent-transport", () => ({
  agentInvoke: (...args: unknown[]) => mockAgentInvoke(...args),
}))

import Dexie from "dexie"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { getSettings, saveSettings } from "./settings"
import { tryBuildProjectKnowledgeDeps } from "@/lib/project-knowledge/runtime/build-deps"
import { loggers } from "@cognia/logging"
import { commitTranscriptIndexPage } from "./chat-transcript-index"

const projectDepsMock = tryBuildProjectKnowledgeDeps as jest.Mock
import {
  deleteProjectCascade,
  detachProjectContents,
  ensureDefaultProject,
  resolveScopeProjectId,
  resolveSessionProjectId,
  scopedWhere,
  DEFAULT_PROJECT_ID,
} from "./project-scope"

describe("project-scope helper", () => {
  const dbFixture = createDbTestFixture()

  beforeAll(dbFixture.initialize)
  beforeEach(async () => {
    mockDeleteExternalSession.mockReset().mockResolvedValue(undefined)
    mockAgentInvoke.mockReset().mockResolvedValue(undefined)
    await dbFixture.restore()
    // Let the background built-in seed settle before exercising heavy
    // multi-table cascades, so seeding transactions don't race the test.
  })
  afterAll(dbFixture.dispose)

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
    it("cleans chat and Squad gateway histories first and retains workspace data on failure", async () => {
      const db = getDb()
      await db.sessions.put({
        id: "managed-chat",
        projectId: "A",
        title: "Managed",
        createdAt: 1,
        updatedAt: 1,
        externalAgentSession: { agentId: "agent", sessionId: "cognia-gateway:chat-task:native" },
      } as never)
      await db.agentTeamRuns.put({
        id: "managed-run",
        teamId: "team",
        projectId: "A",
        objective: "Work",
        decisionVersion: 0,
        priority: 1,
        status: "completed",
        createdAt: 1,
        updatedAt: 1,
      })
      await db.agentTeamChildRuns.put({
        id: "managed-child",
        runId: "managed-run",
        teamId: "team",
        teammateId: "mate",
        taskId: "task",
        repositoryId: "primary",
        attempt: 1,
        status: "completed",
        sessionId: "cognia-gateway:team-task:native",
        createdAt: 1,
        updatedAt: 1,
        resourceUsage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          wallTimeMs: 0,
          toolTimeMs: 0,
          attempts: 1,
          failures: 0,
        },
      })
      mockAgentInvoke.mockRejectedValueOnce(new Error("task active"))
      await expect(deleteProjectCascade("A")).rejects.toThrow("task active")
      expect(await db.sessions.get("managed-chat")).toBeDefined()
      expect(await db.agentTeamChildRuns.get("managed-child")).toBeDefined()
      await deleteProjectCascade("A")
      expect(mockDeleteExternalSession).toHaveBeenCalledWith(
        "agent",
        "cognia-gateway:chat-task:native"
      )
      expect(mockAgentInvoke).toHaveBeenCalledWith("external_agent_delete_gateway_task", {
        taskId: "team-task",
      })
      expect(await db.sessions.get("managed-chat")).toBeUndefined()
      expect(await db.agentTeamChildRuns.get("managed-child")).toBeUndefined()
    })

    it("records deletion markers for project sessions, messages and unread state atomically", async () => {
      await seedProjectMedia()
      const db = getDb()
      await deleteProjectCascade("A")
      for (const [table, id] of [
        ["sessions", "session-A"],
        ["messages", "message-A"],
        ["sessionState", "session-A"],
      ]) {
        expect(await db.syncTombstones.get([table, id])).toMatchObject({ table, id })
      }
      expect(await db.syncTombstones.get(["sessions", "session-B"])).toBeUndefined()
    })

    it("rolls back the project cascade when deletion evidence cannot be written", async () => {
      await seedProjectMedia()
      const db = getDb()
      const fail = jest
        .spyOn(db.syncTombstones, "bulkPut")
        .mockRejectedValueOnce(new Error("marker write failed"))
      try {
        await expect(deleteProjectCascade("A")).rejects.toThrow("marker write failed")
        expect(await db.sessions.get("session-A")).toBeDefined()
        expect(await db.messages.get("message-A")).toBeDefined()
        expect(await db.messageMediaRefs.where("sessionId").equals("session-A").count()).toBe(3)
        expect(await db.syncTombstones.get(["sessions", "session-A"])).toBeUndefined()
      } finally {
        fail.mockRestore()
      }
    })

    it("uses transaction-time membership for both deletion and markers", async () => {
      await seedProjectMedia()
      const db = getDb()
      const transaction = db.transaction.bind(db)
      const intercept = jest.spyOn(db, "transaction").mockImplementationOnce((...args: unknown[]) =>
        Dexie.Promise.resolve(
          Dexie.ignoreTransaction(async () => {
            await db.sessions.update("session-A", { projectId: "B" })
            await db.messages.update("message-A", { projectId: "B" })
            await db.sessions.put({
              id: "arrived",
              projectId: "A",
              createdAt: 1,
              updatedAt: 1,
              title: "new",
            } as never)
            await db.sessionState.put({ sessionId: "arrived", lastReadAt: 1, unreadCount: 0 })
            return Reflect.apply(transaction, db, args)
          })
        )
      )
      try {
        await deleteProjectCascade("A")
        expect(await db.sessions.get("session-A")).toMatchObject({ projectId: "B" })
        expect(await db.messageMediaRefs.where("sessionId").equals("session-A").count()).toBe(3)
        expect(await db.syncTombstones.get(["sessions", "session-A"])).toBeUndefined()
        expect(await db.sessions.get("arrived")).toBeUndefined()
        expect(await db.sessionState.get("arrived")).toBeUndefined()
        expect(await db.syncTombstones.get(["sessions", "arrived"])).toBeDefined()
      } finally {
        intercept.mockRestore()
      }
    })

    it("retains newly attached gateway sessions until a retry cleans their history", async () => {
      const db = getDb()
      const transaction = db.transaction.bind(db)
      const intercept = jest.spyOn(db, "transaction").mockImplementationOnce((...args: unknown[]) =>
        Dexie.Promise.resolve(
          Dexie.ignoreTransaction(async () => {
            await db.sessions.put({
              id: "late-managed",
              projectId: "A",
              title: "Late",
              createdAt: 1,
              updatedAt: 1,
              externalAgentSession: {
                agentId: "agent",
                sessionId: "cognia-gateway:late-task:native",
              },
            } as never)
            return Reflect.apply(transaction, db, args)
          })
        )
      )
      try {
        await expect(deleteProjectCascade("A")).rejects.toThrow("sessions changed")
        expect(await db.sessions.get("late-managed")).toBeDefined()
        expect(mockDeleteExternalSession).not.toHaveBeenCalled()
      } finally {
        intercept.mockRestore()
      }
      await deleteProjectCascade("A")
      expect(mockDeleteExternalSession).toHaveBeenCalledWith(
        "agent",
        "cognia-gateway:late-task:native"
      )
      expect(await db.sessions.get("late-managed")).toBeUndefined()
    })

    async function seedProjectMedia() {
      const db = getDb()
      for (const projectId of ["A", "B"]) {
        const sessionId = `session-${projectId}`
        await db.sessions.put({
          id: sessionId,
          projectId,
          title: projectId,
          kind: "direct",
          createdAt: 1,
          updatedAt: 1,
        })
        await db.messages.put({
          id: `message-${projectId}`,
          sessionId,
          projectId,
          role: "user",
          parts: [],
          createdAt: 1,
        } as never)
        await db.messageMediaRefs.bulkPut(
          (projectId === "A" ? ["exclusive", "shared", "recent"] : ["shared"]).map((hash) => ({
            sessionId,
            messageId: `message-${projectId}`,
            hash,
          }))
        )
        await commitTranscriptIndexPage({
          sessionId,
          revision: 1,
          complete: true,
          items: [
            {
              kind: "completed-turn",
              itemKey: "turn",
              turnKey: "turn",
              revision: 1,
              detailRevision: 1,
              status: "completed",
              userMessages: [],
              startedAt: 1,
              collapsed: { exists: false, messageCount: 1, trailingCount: 0, mediaCount: 0 },
            },
          ],
        })
      }
      for (const hash of ["exclusive", "shared", "recent", "unrelated-orphan"]) {
        await db.messageMedia.put({
          hash,
          mediaType: "image/png",
          width: 1,
          height: 1,
          blob: new Blob(["image"]),
          byteSize: 5,
          createdAt: hash === "recent" ? Date.now() : 1,
          lastUsedAt: 1,
        })
      }
    }

    it("removes derived session indexes and only unreferenced candidate media", async () => {
      await seedProjectMedia()
      await deleteProjectCascade("A")

      const db = getDb()
      expect(await db.messageMediaRefs.toArray()).toEqual([
        { sessionId: "session-B", messageId: "message-B", hash: "shared" },
      ])
      expect((await db.chatTurnSummaries.toArray()).map((row) => row.sessionId)).toEqual([
        "session-B",
      ])
      expect((await db.chatTranscriptIndexState.toArray()).map((row) => row.sessionId)).toEqual([
        "session-B",
      ])
      expect((await db.messageMedia.toArray()).map((row) => row.hash).sort()).toEqual([
        "recent",
        "shared",
        "unrelated-orphan",
      ])
      expect(await db.messages.get("message-B")).toBeDefined()
    })

    it("rolls back project and derived rows when the cascade fails", async () => {
      await seedProjectMedia()
      const db = getDb()
      const failDelete = () => {
        throw new Error("derived delete failed")
      }
      db.chatTranscriptIndexState.hook("deleting", failDelete)
      try {
        await expect(deleteProjectCascade("A")).rejects.toThrow("derived delete failed")
      } finally {
        db.chatTranscriptIndexState.hook("deleting").unsubscribe(failDelete)
      }
      expect(await db.sessions.get("session-A")).toBeDefined()
      expect(await db.messages.get("message-A")).toBeDefined()
      expect(await db.messageMediaRefs.count()).toBe(4)
      expect(await db.chatTurnSummaries.count()).toBe(2)
      expect(await db.chatTranscriptIndexState.count()).toBe(2)
      expect(await db.messageMedia.count()).toBe(4)
    })

    it("does not report a committed project cascade as failed when media GC fails", async () => {
      await seedProjectMedia()
      const db = getDb()
      const failDelete = () => {
        throw new Error("media unavailable")
      }
      db.messageMedia.hook("deleting", failDelete)
      const warn = jest.spyOn(loggers.store, "warn").mockImplementation(() => {})
      try {
        await expect(deleteProjectCascade("A")).resolves.toBeUndefined()
        expect(warn).toHaveBeenCalledWith("project media cleanup failed", {
          projectId: "A",
          error: "Error: media unavailable",
        })
      } finally {
        db.messageMedia.hook("deleting").unsubscribe(failDelete)
        warn.mockRestore()
      }
      expect(await db.sessions.get("session-A")).toBeUndefined()
      expect(await db.messageMediaRefs.where("sessionId").equals("session-A").count()).toBe(0)
      expect(await db.messageMedia.get("exclusive")).toBeDefined()
    })

    it("removes every scoped row + session-child row for the project, leaving others intact", async () => {
      const db = getDb()
      // Project A data.
      await db.sessions.bulkPut([
        {
          id: "sA",
          projectId: "A",
          title: "a",
          updatedAt: 1,
          createdAt: 1,
          platformBinding: { conversationKey: "telegram:a:chat-a", platform: "telegram" },
        },
        { id: "sB", projectId: "B", title: "b", updatedAt: 1, createdAt: 1 },
      ] as never)
      await db.connectorInboundJobs.bulkPut([
        {
          id: "inA",
          adapterId: "a",
          platformMessageId: "m-in-a",
          sourceMessageId: "m-in-a",
          conversationKey: "telegram:a:chat-a",
          event: {},
          dispatchMode: "fifo",
          status: "completed",
          attempts: 1,
          receivedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "inB",
          adapterId: "b",
          platformMessageId: "m-in-b",
          sourceMessageId: "m-in-b",
          conversationKey: "telegram:b:chat-b",
          event: {},
          dispatchMode: "fifo",
          status: "completed",
          attempts: 1,
          receivedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        },
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
      expect(await db.connectorInboundJobs.get("inA")).toBeUndefined()
      // Project B is untouched.
      expect(await db.sessions.get("sB")).toBeDefined()
      expect(await db.messages.get("mB")).toBeDefined()
      expect(await db.chatGoals.get("gB")).toBeDefined()
      expect(await db.chatGoalEvents.get("geB")).toBeDefined()
      expect(await db.canvasDocuments.get("dB")).toBeDefined()
      expect(await db.canvasVersions.get("vB")).toBeDefined()
      expect(await db.sessionUsage.get("mB")).toBeDefined()
      expect(await db.connectorInboundJobs.get("inB")).toBeDefined()
    }, 30000)

    it("is a no-op for a project with no data", async () => {
      await expect(deleteProjectCascade("empty")).resolves.toBeUndefined()
    }, 30000)

    it("purges durable AgentTeam runs, environments, children, and orphaned content", async () => {
      const db = getDb()
      await db.agentTeamRuns.bulkPut([
        {
          id: "runA",
          teamId: "teamA",
          projectId: "A",
          objective: "a",
          status: "completed",
          priority: 1,
          decisionVersion: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "runB",
          teamId: "teamB",
          projectId: "B",
          objective: "b",
          status: "completed",
          priority: 1,
          decisionVersion: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ] as never)
      await db.agentTeamTrajectory.bulkPut([
        {
          id: "runA:1",
          runId: "runA",
          sequence: 1,
          kind: "model_turn_completed",
          correlationId: "a",
          contentHash: "hashA",
          createdAt: 1,
        },
        {
          id: "runB:1",
          runId: "runB",
          sequence: 1,
          kind: "model_turn_completed",
          correlationId: "b",
          contentHash: "hashB",
          createdAt: 1,
        },
      ] as never)
      await db.agentTeamContentObjects.bulkPut([
        {
          hash: "hashA",
          mimeType: "text/plain",
          byteLength: 1,
          data: new Uint8Array([1]),
          createdAt: 1,
        },
        {
          hash: "hashB",
          mimeType: "text/plain",
          byteLength: 1,
          data: new Uint8Array([2]),
          createdAt: 1,
        },
      ])
      await db.projectEnvironments.bulkPut([
        {
          id: "envA",
          projectId: "A",
          name: "A",
          isEnabled: true,
          setupScript: { default: "" },
          actions: [],
          variables: {},
          keyringReferences: [],
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "envB",
          projectId: "B",
          name: "B",
          isEnabled: true,
          setupScript: { default: "" },
          actions: [],
          variables: {},
          keyringReferences: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ])

      await deleteProjectCascade("A")

      expect(await db.agentTeamRuns.get("runA")).toBeUndefined()
      expect(await db.agentTeamTrajectory.get("runA:1")).toBeUndefined()
      expect(await db.agentTeamContentObjects.get("hashA")).toBeUndefined()
      expect(await db.projectEnvironments.get("envA")).toBeUndefined()
      expect(await db.agentTeamRuns.get("runB")).toBeDefined()
      expect(await db.agentTeamContentObjects.get("hashB")).toBeDefined()
      expect(await db.projectEnvironments.get("envB")).toBeDefined()
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
  describe("detachProjectContents", () => {
    it("hands the rows to Default instead of destroying them", async () => {
      const db = getDb()
      await db.projects.put({
        id: "project-a",
        name: "Alpha",
        roots: [{ id: "ra", path: "/repos/a", isPrimary: true }],
        sessionIds: [],
        createdAt: 1,
        updatedAt: 1,
      } as never)
      await db.sessions.put({
        id: "s1",
        title: "kept",
        projectId: "project-a",
        createdAt: 1,
        updatedAt: 1,
        // Names the workspace being removed, so every later send would resolve
        // against a project that no longer exists.
        executionContext: {
          location: "local",
          projectId: "project-a",
          projectRoot: "/repos/a",
          taskWorkspace: { taskId: "t", workspaceKey: "w" },
        },
      } as never)

      const landedIn = await detachProjectContents("project-a")

      expect(landedIn).toBe(DEFAULT_PROJECT_ID)
      const moved = await db.sessions.get("s1")
      expect(moved?.projectId).toBe(DEFAULT_PROJECT_ID)
      // Dropped so the next send rebuilds the binding cleanly rather than
      // failing forever against a workspace that is gone.
      expect(moved?.executionContext).toBeUndefined()
      expect(await db.sessions.count()).toBeGreaterThan(0)
    })

    it("refuses to detach Default into itself", async () => {
      await ensureDefaultProject()
      await expect(detachProjectContents(DEFAULT_PROJECT_ID)).rejects.toThrow(/Default/)
    })
  })
})
