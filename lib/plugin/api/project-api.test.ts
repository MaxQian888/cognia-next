/**
 * Tests for Project Plugin API
 */

import { createProjectAPI, createInvocationProjectAPI } from "./project-api"
import { initializePluginPermissions, grantPermission, revokePermission } from "./permission-api"
import type { Project, KnowledgeFile } from "@/types"
import { buildTextDocumentStructure, documentContentHash } from "@cognia/document"
import {
  registerKnowledgeReaderForSession,
  clearKnowledgeReaderForSession,
} from "@/lib/knowledge-base/runtime/session-reader"
import type { KnowledgeBaseSource } from "@/types/knowledge-base"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"

// Mock project store
const mockProjects: Project[] = []
let mockActiveProjectId: string | null = null
const mockSubscribers: Array<(state: unknown) => void> = []

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: {
    getState: jest.fn(() => ({
      projects: mockProjects,
      activeProjectId: mockActiveProjectId,
      createProject: jest.fn((options) => {
        const project: Project = {
          id: `project-${Date.now()}`,
          name: options.name || "New Project",
          description: options.description || "",
          customInstructions: options.systemPrompt,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastAccessedAt: new Date(),
          roots: [],
          knowledgeBase: [],
          sessionIds: [],
          sessionCount: 0,
          messageCount: 0,
          tags: options.tags || [],
          isArchived: false,
        }
        mockProjects.push(project)
        return project
      }),
      updateProject: jest.fn((id, updates) => {
        const idx = mockProjects.findIndex((p) => p.id === id)
        if (idx >= 0) {
          Object.assign(mockProjects[idx], updates, { updatedAt: new Date() })
        }
      }),
      deleteProject: jest.fn((id) => {
        const idx = mockProjects.findIndex((p) => p.id === id)
        if (idx >= 0) mockProjects.splice(idx, 1)
      }),
      setActiveProject: jest.fn((id) => {
        mockActiveProjectId = id
      }),
      archiveProject: jest.fn((id) => {
        const project = mockProjects.find((p) => p.id === id)
        if (project) project.isArchived = true
      }),
      unarchiveProject: jest.fn((id) => {
        const project = mockProjects.find((p) => p.id === id)
        if (project) project.isArchived = false
      }),
      addKnowledgeFile: jest.fn((projectId, file) => {
        const project = mockProjects.find((p) => p.id === projectId)
        if (project) {
          const newFile: KnowledgeFile = {
            id: `file-${Date.now()}`,
            ...file,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
          project.knowledgeBase.push(newFile)
        }
      }),
      removeKnowledgeFile: jest.fn((projectId, fileId) => {
        const project = mockProjects.find((p) => p.id === projectId)
        if (project) {
          const idx = project.knowledgeBase.findIndex((f) => f.id === fileId)
          if (idx >= 0) project.knowledgeBase.splice(idx, 1)
        }
      }),
      updateKnowledgeFile: jest.fn((projectId, fileId, content) => {
        const project = mockProjects.find((p) => p.id === projectId)
        if (project) {
          const file = project.knowledgeBase.find((f) => f.id === fileId)
          if (file) file.content = content
        }
      }),
      addSessionToProject: jest.fn((projectId, sessionId) => {
        const project = mockProjects.find((p) => p.id === projectId)
        if (project && !project.sessionIds.includes(sessionId)) {
          project.sessionIds.push(sessionId)
        }
      }),
      removeSessionFromProject: jest.fn((projectId, sessionId) => {
        const project = mockProjects.find((p) => p.id === projectId)
        if (project) {
          const idx = project.sessionIds.indexOf(sessionId)
          if (idx >= 0) project.sessionIds.splice(idx, 1)
        }
      }),
      addTag: jest.fn((projectId, tag) => {
        const project = mockProjects.find((p) => p.id === projectId)
        if (project && !project.tags?.includes(tag)) {
          if (!project.tags) project.tags = []
          project.tags.push(tag)
        }
      }),
      removeTag: jest.fn((projectId, tag) => {
        const project = mockProjects.find((p) => p.id === projectId)
        if (project?.tags) {
          const idx = project.tags.indexOf(tag)
          if (idx >= 0) project.tags.splice(idx, 1)
        }
      }),
    })),
    subscribe: jest.fn((callback) => {
      mockSubscribers.push(callback)
      return () => {
        const idx = mockSubscribers.indexOf(callback)
        if (idx >= 0) mockSubscribers.splice(idx, 1)
      }
    }),
  },
}))

describe("Project API", () => {
  const testPluginId = "test-plugin"

  beforeEach(() => {
    mockProjects.length = 0
    mockActiveProjectId = null
    mockSubscribers.length = 0
  })

  describe("createProjectAPI", () => {
    it("should create an API object with all expected methods", () => {
      const api = createProjectAPI(testPluginId)

      expect(api).toBeDefined()
      expect(typeof api.getCurrentProject).toBe("function")
      expect(typeof api.getCurrentProjectId).toBe("function")
      expect(typeof api.getProject).toBe("function")
      expect(typeof api.createProject).toBe("function")
      expect(typeof api.updateProject).toBe("function")
      expect(typeof api.deleteProject).toBe("function")
      expect(typeof api.setActiveProject).toBe("function")
      expect(typeof api.listProjects).toBe("function")
      expect(typeof api.archiveProject).toBe("function")
      expect(typeof api.unarchiveProject).toBe("function")
      expect(typeof api.addKnowledgeFile).toBe("function")
      expect(typeof api.removeKnowledgeFile).toBe("function")
      expect(typeof api.updateKnowledgeFile).toBe("function")
      expect(typeof api.getKnowledgeFiles).toBe("function")
      expect(typeof api.linkSession).toBe("function")
      expect(typeof api.unlinkSession).toBe("function")
      expect(typeof api.getProjectSessions).toBe("function")
      expect(typeof api.onProjectChange).toBe("function")
      expect(typeof api.addTag).toBe("function")
      expect(typeof api.removeTag).toBe("function")
    })
  })

  describe("getCurrentProject / getCurrentProjectId", () => {
    it("should return null when no project is active", () => {
      const api = createProjectAPI(testPluginId)

      expect(api.getCurrentProject()).toBeNull()
      expect(api.getCurrentProjectId()).toBeNull()
    })

    it("should return current project when one is active", () => {
      const project: Project = {
        id: "proj-1",
        name: "Test Project",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccessedAt: new Date(),
        roots: [],
        knowledgeBase: [],
        sessionIds: [],
        sessionCount: 0,
        messageCount: 0,
        isArchived: false,
      }
      mockProjects.push(project)
      mockActiveProjectId = "proj-1"

      const api = createProjectAPI(testPluginId)

      expect(api.getCurrentProject()?.id).toBe("proj-1")
      expect(api.getCurrentProjectId()).toBe("proj-1")
    })
  })

  describe("getProject", () => {
    it("should return project by ID", async () => {
      const project: Project = {
        id: "proj-123",
        name: "Specific Project",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccessedAt: new Date(),
        roots: [],
        knowledgeBase: [],
        sessionIds: [],
        sessionCount: 0,
        messageCount: 0,
        isArchived: false,
      }
      mockProjects.push(project)

      const api = createProjectAPI(testPluginId)
      const result = await api.getProject("proj-123")

      expect(result?.name).toBe("Specific Project")
    })

    it("should return null for non-existent project", async () => {
      const api = createProjectAPI(testPluginId)
      const result = await api.getProject("non-existent")

      expect(result).toBeNull()
    })
  })

  describe("createProject", () => {
    it("should create a new project", async () => {
      const api = createProjectAPI(testPluginId)

      const project = await api.createProject({
        name: "New Project",
        description: "A test project",
      })

      expect(project.id).toBeDefined()
      expect(project.name).toBe("New Project")
      expect(mockProjects.length).toBe(1)
    })
  })

  describe("updateProject", () => {
    it("should update an existing project", async () => {
      const project: Project = {
        id: "update-proj",
        name: "Original Name",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccessedAt: new Date(),
        roots: [],
        knowledgeBase: [],
        sessionIds: [],
        sessionCount: 0,
        messageCount: 0,
        isArchived: false,
      }
      mockProjects.push(project)

      const api = createProjectAPI(testPluginId)
      await api.updateProject("update-proj", { name: "Updated Name" })

      expect(mockProjects[0].name).toBe("Updated Name")
    })
  })

  describe("deleteProject", () => {
    it("should delete a project", async () => {
      mockProjects.push({
        id: "delete-proj",
        name: "To Delete",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccessedAt: new Date(),
        roots: [],
        knowledgeBase: [],
        sessionIds: [],
        sessionCount: 0,
        messageCount: 0,
        isArchived: false,
      })

      const api = createProjectAPI(testPluginId)
      await api.deleteProject("delete-proj")

      expect(mockProjects.length).toBe(0)
    })
  })

  describe("setActiveProject", () => {
    it("should set active project", async () => {
      const api = createProjectAPI(testPluginId)
      await api.setActiveProject("proj-to-activate")

      expect(mockActiveProjectId).toBe("proj-to-activate")
    })

    it("should clear active project when null", async () => {
      mockActiveProjectId = "some-proj"

      const api = createProjectAPI(testPluginId)
      await api.setActiveProject(null)

      expect(mockActiveProjectId).toBeNull()
    })
  })

  describe("listProjects", () => {
    beforeEach(() => {
      const now = new Date()
      mockProjects.push(
        {
          id: "p1",
          name: "Project 1",
          createdAt: new Date(now.getTime() - 3000),
          updatedAt: now,
          lastAccessedAt: now,
          roots: [],
          knowledgeBase: [],
          sessionIds: [],
          sessionCount: 0,
          messageCount: 0,
          tags: ["tag1"],
          isArchived: false,
        },
        {
          id: "p2",
          name: "Project 2",
          createdAt: new Date(now.getTime() - 2000),
          updatedAt: now,
          lastAccessedAt: now,
          roots: [],
          knowledgeBase: [],
          sessionIds: [],
          sessionCount: 0,
          messageCount: 0,
          tags: ["tag2"],
          isArchived: true,
        },
        {
          id: "p3",
          name: "Project 3",
          createdAt: new Date(now.getTime() - 1000),
          updatedAt: now,
          lastAccessedAt: now,
          roots: [],
          knowledgeBase: [],
          sessionIds: [],
          sessionCount: 0,
          messageCount: 0,
          tags: ["tag1", "tag2"],
          isArchived: false,
        }
      )
    })

    it("should list all projects", async () => {
      const api = createProjectAPI(testPluginId)
      const result = await api.listProjects()

      expect(result.length).toBe(3)
    })

    it("should filter by archived status", async () => {
      const api = createProjectAPI(testPluginId)

      const active = await api.listProjects({ isArchived: false })
      expect(active.length).toBe(2)

      const archived = await api.listProjects({ isArchived: true })
      expect(archived.length).toBe(1)
    })

    it("should filter by tags", async () => {
      const api = createProjectAPI(testPluginId)

      const result = await api.listProjects({ tags: ["tag1"] })
      expect(result.length).toBe(2)
    })

    it("should apply pagination", async () => {
      const api = createProjectAPI(testPluginId)

      const limited = await api.listProjects({ limit: 2 })
      expect(limited.length).toBe(2)

      const offset = await api.listProjects({ offset: 1 })
      expect(offset.length).toBe(2)
    })
  })

  describe("archiveProject / unarchiveProject", () => {
    it("should archive a project", async () => {
      mockProjects.push({
        id: "archive-proj",
        name: "To Archive",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccessedAt: new Date(),
        roots: [],
        knowledgeBase: [],
        sessionIds: [],
        sessionCount: 0,
        messageCount: 0,
        isArchived: false,
      })

      const api = createProjectAPI(testPluginId)
      await api.archiveProject("archive-proj")

      expect(mockProjects[0].isArchived).toBe(true)
    })

    it("should unarchive a project", async () => {
      mockProjects.push({
        id: "unarchive-proj",
        name: "To Unarchive",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccessedAt: new Date(),
        roots: [],
        knowledgeBase: [],
        sessionIds: [],
        sessionCount: 0,
        messageCount: 0,
        isArchived: true,
      })

      const api = createProjectAPI(testPluginId)
      await api.unarchiveProject("unarchive-proj")

      expect(mockProjects[0].isArchived).toBe(false)
    })
  })

  describe("Knowledge file management", () => {
    beforeEach(() => {
      mockProjects.push({
        id: "kb-proj",
        name: "KB Project",
        roots: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccessedAt: new Date(),
        knowledgeBase: [
          {
            id: "file-1",
            name: "doc.md",
            content: "Content 1",
            type: "markdown",
            size: 100,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        sessionIds: [],
        sessionCount: 0,
        messageCount: 0,
        isArchived: false,
      })
    })

    it("should add knowledge file", async () => {
      const api = createProjectAPI(testPluginId)

      const file = await api.addKnowledgeFile("kb-proj", {
        name: "new-file.txt",
        content: "New content",
      })

      expect(file).toBeDefined()
      expect(mockProjects[0].knowledgeBase.length).toBe(2)
    })

    it("returns the file it added, read after the store replaced the row", async () => {
      // The real store swaps the project object on every mutation, so the
      // snapshot taken before the write still holds the old knowledge list.
      const { useProjectStore } = jest.requireMock("@/stores/project/project-store") as {
        useProjectStore: { getState: jest.Mock }
      }
      const live = useProjectStore.getState()
      useProjectStore.getState.mockImplementationOnce(() => ({
        ...live,
        projects: [...mockProjects],
        addKnowledgeFile: (projectId: string, input: Omit<KnowledgeFile, "id">) => {
          const idx = mockProjects.findIndex((p) => p.id === projectId)
          mockProjects[idx] = {
            ...mockProjects[idx],
            knowledgeBase: [
              ...mockProjects[idx].knowledgeBase,
              { ...input, id: "file-new", createdAt: new Date(), updatedAt: new Date() },
            ],
          }
        },
      }))
      const api = createProjectAPI(testPluginId)

      const file = await api.addKnowledgeFile("kb-proj", { name: "fresh.md", content: "x" })

      expect(file.id).toBe("file-new")
      expect(file.name).toBe("fresh.md")
    })

    it("refuses a knowledge file for a project that does not exist", async () => {
      const api = createProjectAPI(testPluginId)

      await expect(
        api.addKnowledgeFile("no-such-project", { name: "a.md", content: "x" })
      ).rejects.toThrow("Project not found")
    })

    it("should infer file type from extension", async () => {
      const api = createProjectAPI(testPluginId)

      await api.addKnowledgeFile("kb-proj", {
        name: "script.py",
        content: 'print("hello")',
      })

      const files = await api.getKnowledgeFiles("kb-proj")
      const pyFile = files.find((f) => f.name === "script.py")
      expect(pyFile?.type).toBe("code")
    })

    it("should infer new document types from extension", async () => {
      const api = createProjectAPI(testPluginId)

      await api.addKnowledgeFile("kb-proj", {
        name: "slides.pptx",
        content: "presentation content",
      })
      await api.addKnowledgeFile("kb-proj", {
        name: "notes.rtf",
        content: "{\\rtf1\\ansi sample}",
      })
      await api.addKnowledgeFile("kb-proj", {
        name: "book.epub",
        content: "epub content",
      })
      await api.addKnowledgeFile("kb-proj", {
        name: "notes.odt",
        content: "odt content",
      })
      await api.addKnowledgeFile("kb-proj", {
        name: "financials.xlsm",
        content: "xlsm content",
      })
      await api.addKnowledgeFile("kb-proj", {
        name: "slides.pptm",
        content: "pptm content",
      })

      const files = await api.getKnowledgeFiles("kb-proj")
      expect(files.find((f) => f.name === "slides.pptx")?.type).toBe("presentation")
      expect(files.find((f) => f.name === "notes.rtf")?.type).toBe("rtf")
      expect(files.find((f) => f.name === "book.epub")?.type).toBe("epub")
      expect(files.find((f) => f.name === "notes.odt")?.type).toBe("word")
      expect(files.find((f) => f.name === "financials.xlsm")?.type).toBe("excel")
      expect(files.find((f) => f.name === "slides.pptm")?.type).toBe("presentation")
    })

    it("should remove knowledge file", async () => {
      const api = createProjectAPI(testPluginId)
      await api.removeKnowledgeFile("kb-proj", "file-1")

      expect(mockProjects[0].knowledgeBase.length).toBe(0)
    })

    it("should update knowledge file", async () => {
      const api = createProjectAPI(testPluginId)
      await api.updateKnowledgeFile("kb-proj", "file-1", "Updated content")

      expect(mockProjects[0].knowledgeBase[0].content).toBe("Updated content")
    })

    it("should get knowledge files", async () => {
      const api = createProjectAPI(testPluginId)
      const files = await api.getKnowledgeFiles("kb-proj")

      expect(files.length).toBe(1)
      expect(files[0].name).toBe("doc.md")
    })

    it("should return empty array for non-existent project", async () => {
      const api = createProjectAPI(testPluginId)
      const files = await api.getKnowledgeFiles("non-existent")

      expect(files).toEqual([])
    })
  })

  describe("Session linking", () => {
    beforeEach(() => {
      mockProjects.push({
        id: "session-proj",
        name: "Session Project",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccessedAt: new Date(),
        roots: [],
        knowledgeBase: [],
        sessionIds: ["session-1"],
        sessionCount: 0,
        messageCount: 0,
        isArchived: false,
      })
    })

    it("should link session to project", async () => {
      const api = createProjectAPI(testPluginId)
      await api.linkSession("session-proj", "session-2")

      expect(mockProjects[0].sessionIds).toContain("session-2")
    })

    it("should unlink session from project", async () => {
      const api = createProjectAPI(testPluginId)
      await api.unlinkSession("session-proj", "session-1")

      expect(mockProjects[0].sessionIds).not.toContain("session-1")
    })

    it("should get project sessions", async () => {
      const api = createProjectAPI(testPluginId)
      const sessions = await api.getProjectSessions("session-proj")

      expect(sessions).toContain("session-1")
    })
  })

  describe("Tag management", () => {
    beforeEach(() => {
      mockProjects.push({
        id: "tag-proj",
        name: "Tag Project",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccessedAt: new Date(),
        roots: [],
        knowledgeBase: [],
        sessionIds: [],
        sessionCount: 0,
        messageCount: 0,
        tags: ["existing-tag"],
        isArchived: false,
      })
    })

    it("should add tag to project", async () => {
      const api = createProjectAPI(testPluginId)
      await api.addTag("tag-proj", "new-tag")

      expect(mockProjects[0].tags).toContain("new-tag")
    })

    it("should remove tag from project", async () => {
      const api = createProjectAPI(testPluginId)
      await api.removeTag("tag-proj", "existing-tag")

      expect(mockProjects[0].tags).not.toContain("existing-tag")
    })
  })

  describe("onProjectChange", () => {
    it("should subscribe to project changes", () => {
      const api = createProjectAPI(testPluginId)
      const handler = jest.fn()

      const unsubscribe = api.onProjectChange(handler)

      expect(typeof unsubscribe).toBe("function")
      expect(mockSubscribers.length).toBe(1)
    })

    it("should unsubscribe when cleanup is called", () => {
      const api = createProjectAPI(testPluginId)
      const handler = jest.fn()

      const unsubscribe = api.onProjectChange(handler)
      expect(mockSubscribers.length).toBe(1)

      unsubscribe()
      expect(mockSubscribers.length).toBe(0)
    })
  })
})

// W2.3: the project API is permission-gated; grant the suite's plugin.
beforeAll(() => {
  initializePluginPermissions("test-plugin", ["project:read", "project:write", "project:delete"])
})

describe("permission gate", () => {
  it("throws PermissionError when project permissions are not granted", () => {
    const api = createProjectAPI("no-perms-plugin")
    expect(() => api.listProjects()).toThrow(/project:read/)
    expect(() => api.deleteProject("x")).toThrow(/project:delete/)
  })
})

describe("progressive document API", () => {
  const scope = { kind: "project" as const, projectId: "reading-project" }
  const original = "# Guide\nOpening\n## Procedure\n```sh\nkeep-original-code\n```\nFinal text"
  beforeEach(() => {
    mockProjects.length = 0
    mockProjects.push({
      id: scope.projectId,
      knowledgeBase: [{ id: "doc", name: "guide.md", type: "markdown", content: original }],
    } as Project)
    revokePermission("test-plugin", "knowledge:read")
  })
  afterEach(() => clearKnowledgeReaderForSession("reading-session"))

  it("lists metadata, reads directory and original code through the same canonical parser", async () => {
    const api = createProjectAPI("test-plugin")
    const directory = await api.listKnowledgeDocuments({ scope })
    expect(directory.documents).toHaveLength(1)
    expect(directory.documents[0]).not.toHaveProperty("text")
    const document = directory.documents[0]
    const identity = { scope, ...document }
    const outline = await api.readKnowledgeOutline(identity)
    const section = outline.nodes.find((node) => node.title === "Procedure")!
    expect(section.parentId).toBeDefined()
    const read = await api.readKnowledgeRange({ ...identity, sectionId: section.id, maxChars: 100 })
    expect(read.text).toContain("```sh\nkeep-original-code")
    const location = await api.locateKnowledgeDocument({ ...identity, sectionId: section.id })
    expect(location.charStart).toBe(section.charStart)
    expect(location.generationId).toBe(documentContentHash(original))
  })

  it("rejects cross-project identity, stale versions and deleted originals", async () => {
    const api = createProjectAPI("test-plugin")
    const document = (await api.listKnowledgeDocuments({ scope })).documents[0]
    const identity = { scope, ...document }
    await expect(
      api.readKnowledgeRange({ ...identity, knowledgeBaseId: "project:other" })
    ).rejects.toThrow("source_unavailable")
    mockProjects[0].knowledgeBase[0].structure = buildTextDocumentStructure(original)
    mockProjects[0].knowledgeBase[0].content = "# Replacement\nNew original"
    await expect(api.readKnowledgeRange(identity)).rejects.toThrow("revision_unavailable")
    const newDocument = (await api.listKnowledgeDocuments({ scope })).documents[0]
    const newOutline = await api.readKnowledgeOutline({ scope, ...newDocument })
    expect(newOutline.nodes.some((node) => node.title === "Replacement")).toBe(true)
    mockProjects[0].knowledgeBase = []
    await expect(api.readKnowledgeRange({ scope, ...newDocument })).rejects.toThrow(
      "source_unavailable"
    )
  })

  it("enforces bounded range arguments and retains the per-plugin project call budget", async () => {
    const api = createProjectAPI("test-plugin")
    const document = (await api.listKnowledgeDocuments({ scope })).documents[0]
    await expect(api.readKnowledgeRange({ scope, ...document, maxChars: 100_000 })).rejects.toThrow(
      "invalid_arguments"
    )
    await expect(api.readKnowledgeRange({ scope, ...document, charStart: -1 })).rejects.toThrow(
      "invalid_arguments"
    )
    const bounded = await api.readKnowledgeRange({ scope, ...document, maxChars: 5 })
    expect(bounded.text).toHaveLength(5)
    expect(bounded.nextCharStart).toBe(5)
    for (let i = 0; i < 28; i++) await api.listKnowledgeDocuments({ scope })
    await expect(api.listKnowledgeDocuments({ scope })).rejects.toThrow("call_budget_exhausted")
  })

  it("requires live explicit grants and a real host session reader; plugin input cannot expand scope", async () => {
    const api = createProjectAPI("test-plugin")
    const agentScope = { kind: "agent" as const, sessionId: "reading-session" }
    await expect(api.listKnowledgeDocuments({ scope: agentScope })).rejects.toThrow(
      "permission_denied"
    )
    grantPermission("test-plugin", "knowledge:read")
    await expect(api.listKnowledgeDocuments({ scope: agentScope })).rejects.toThrow(
      "session_scope_unavailable"
    )
    const source: KnowledgeBaseSource = {
      id: "authorized",
      knowledgeBaseId: "bound",
      title: "Public guide",
      kind: "document",
      format: "markdown",
      content: original,
      bytes: original.length,
      fingerprint: "hash",
      status: "ready",
      chunkCount: 0,
      createdAt: 0,
      updatedAt: 0,
      acl: { visibility: "public" },
    }
    registerKnowledgeReaderForSession("reading-session", {
      knowledgeBaseIds: ["bound"],
      entrypoint: "mcp",
      settings: { enabled: true },
      deps: {
        listSources: async () => [source],
        getSources: async () => [source],
        getSnapshot: async () => ({
          generationId: "v1",
          contentHash: "hash",
          originalText: original,
          title: source.title,
          format: "markdown",
          createdAt: 0,
          structure: buildTextDocumentStructure(original),
        }),
      },
    })
    const invocation = createInvocationProjectAPI("test-plugin", "reading-session")
    await expect(api.listKnowledgeDocuments({ scope: agentScope })).rejects.toThrow(
      "session_scope_unavailable"
    )
    await expect(
      invocation.api.listKnowledgeDocuments({
        scope: { kind: "agent", sessionId: "foreign-session" },
      })
    ).rejects.toThrow("session_scope_unavailable")
    const directory = await invocation.api.listKnowledgeDocuments({ scope: agentScope })
    await expect(invocation.api.listKnowledgeDocuments({ scope })).rejects.toThrow(
      "source_unavailable"
    )
    expect(() => invocation.api.getCurrentProject()).toThrow("source_unavailable")
    expect(() => invocation.api.getProject(scope.projectId)).toThrow("source_unavailable")
    expect(() => invocation.api.listProjects()).toThrow("source_unavailable")
    expect(() => invocation.api.getKnowledgeFiles(scope.projectId)).toThrow("source_unavailable")
    expect(directory.documents[0].knowledgeBaseId).toBe("bound")
    await expect(
      invocation.api.readKnowledgeRange({
        scope: agentScope,
        knowledgeBaseId: "other",
        sourceId: source.id,
      })
    ).rejects.toThrow("source_unavailable")
    source.acl = { visibility: "private" }
    await expect(
      invocation.api.readKnowledgeRange({
        scope: agentScope,
        knowledgeBaseId: "bound",
        sourceId: source.id,
      })
    ).rejects.toThrow("source_unavailable")
    source.acl = { visibility: "public" }
    invocation.dispose()
    await expect(invocation.api.listKnowledgeDocuments({ scope: agentScope })).rejects.toThrow(
      "session_scope_unavailable"
    )
    const currentInvocation = createInvocationProjectAPI("test-plugin", "reading-session")
    clearKnowledgeReaderForSession("reading-session")
    await expect(
      currentInvocation.api.listKnowledgeDocuments({ scope: agentScope })
    ).rejects.toThrow("session_scope_unavailable")
    revokePermission("test-plugin", "knowledge:read")
    await expect(api.listKnowledgeDocuments({ scope: agentScope })).rejects.toThrow(
      "permission_denied"
    )
  })

  it("passes originals, embedding projection and navigation into existing project indexing writes", async () => {
    const api = createProjectAPI("test-plugin")
    const structure = buildTextDocumentStructure(original)
    const added = await api.addKnowledgeFile(scope.projectId, {
      name: "new.md",
      content: original,
      embeddableContent: "projection",
      structure,
    })
    expect(added).toMatchObject({ content: original, embeddableContent: "projection", structure })
  })

  it("uses the host's configurable budgets and observes a live reading switch", async () => {
    let settings = { enabled: true, maxCalls: 2, maxReadChars: 3 }
    const api = createProjectAPI("test-plugin", { getReadingSettings: () => settings })
    const doc = (await api.listKnowledgeDocuments({ scope })).documents[0]
    const read = await api.readKnowledgeRange({ scope, ...doc })
    expect(read.text).toHaveLength(3)
    await expect(api.readKnowledgeRange({ scope, ...doc })).rejects.toThrow("call_budget_exhausted")
    settings = { ...settings, enabled: false }
    await expect(api.listKnowledgeDocuments({ scope })).rejects.toThrow("reading_disabled")
  })

  it("denies document reads under forbid even with a retained project grant", () => {
    const guard = getPermissionGuard()
    const api = createProjectAPI("test-plugin")
    guard.setTier("test-plugin", "project:read", "forbid")
    expect(() => api.listKnowledgeDocuments({ scope })).toThrow(/project:read/)
    guard.setTier("test-plugin", "project:read", "silent")
  })

  it("immediately denies a host UI revocation without recreating the document API", () => {
    const guard = getPermissionGuard()
    const api = createProjectAPI("test-plugin")
    guard.revoke("test-plugin", "project:read")
    expect(() => api.listKnowledgeDocuments({ scope })).toThrow(/project:read/)
    grantPermission("test-plugin", "project:read")
  })
})
