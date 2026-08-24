/**
 * @jest-environment jsdom
 *
 * Coverage focus: every project-store mutation that owns a plugin hook
 * dispatch fires that dispatch exactly once after the state mutation
 * completes (and not at all when the mutation was a no-op).
 */

const dispatchProjectCreate = jest.fn<Promise<void>, unknown[]>(async () => undefined)
const dispatchProjectUpdate = jest.fn<Promise<void>, unknown[]>(async () => undefined)
const dispatchProjectDelete = jest.fn<Promise<void>, unknown[]>(async () => undefined)
const dispatchProjectSwitch = jest.fn<void, unknown[]>()
const dispatchKnowledgeFileAdd = jest.fn<Promise<void>, unknown[]>(async () => undefined)
const dispatchKnowledgeFileRemove = jest.fn<void, unknown[]>()
const dispatchSessionLinked = jest.fn<void, unknown[]>()
const dispatchSessionUnlinked = jest.fn<void, unknown[]>()
const getAllProjects = jest.fn()
const putProject = jest.fn()
const deleteProjectRow = jest.fn()
const loadActiveProjectId = jest.fn()
const persistActiveProjectId = jest.fn()
const ensureDefaultProject = jest.fn()
const deleteProjectCascade = jest.fn()
const detachProjectContents = jest.fn()

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchProjectCreate,
    dispatchProjectUpdate,
    dispatchProjectDelete,
    dispatchProjectSwitch,
    dispatchKnowledgeFileAdd,
    dispatchKnowledgeFileRemove,
    dispatchSessionLinked,
    dispatchSessionUnlinked,
  }),
}))

jest.mock("@/lib/db/projects", () => ({
  getAllProjects: (...args: unknown[]) => getAllProjects(...args),
  putProject: (...args: unknown[]) => putProject(...args),
  deleteProjectRow: (...args: unknown[]) => deleteProjectRow(...args),
  loadActiveProjectId: (...args: unknown[]) => loadActiveProjectId(...args),
  persistActiveProjectId: (...args: unknown[]) => persistActiveProjectId(...args),
}))

jest.mock("@/lib/db/project-scope", () => ({
  ensureDefaultProject: (...args: unknown[]) => ensureDefaultProject(...args),
  deleteProjectCascade: (...args: unknown[]) => deleteProjectCascade(...args),
  detachProjectContents: (...args: unknown[]) => detachProjectContents(...args),
}))

import { useProjectStore } from "./project-store"
import type { Project } from "@/types"

function projectFixture(overrides: Partial<Project> = {}): Project {
  const now = new Date("2026-01-01T00:00:00.000Z")
  return {
    id: "project-default",
    name: "Default",
    roots: [],
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    ...overrides,
  }
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  dispatchProjectCreate.mockClear()
  dispatchProjectUpdate.mockClear()
  dispatchProjectDelete.mockClear()
  dispatchProjectSwitch.mockClear()
  dispatchKnowledgeFileAdd.mockClear()
  dispatchKnowledgeFileRemove.mockClear()
  dispatchSessionLinked.mockClear()
  dispatchSessionUnlinked.mockClear()
  getAllProjects.mockReset().mockResolvedValue([])
  putProject.mockReset().mockResolvedValue(undefined)
  deleteProjectRow.mockReset().mockResolvedValue(undefined)
  loadActiveProjectId.mockReset().mockResolvedValue(null)
  persistActiveProjectId.mockReset().mockResolvedValue(undefined)
  ensureDefaultProject.mockReset().mockResolvedValue(projectFixture())
  deleteProjectCascade.mockReset().mockResolvedValue(undefined)
  detachProjectContents.mockReset().mockResolvedValue("project-default")
})

describe("load", () => {
  it("establishes the default project outside live queries when no active project is persisted", async () => {
    const fallback = projectFixture()
    getAllProjects.mockResolvedValueOnce([])
    loadActiveProjectId.mockResolvedValueOnce(null)
    ensureDefaultProject.mockResolvedValueOnce(fallback)

    await useProjectStore.getState().load()

    expect(ensureDefaultProject).toHaveBeenCalledTimes(1)
    expect(useProjectStore.getState().loaded).toBe(true)
    expect(useProjectStore.getState().activeProjectId).toBe(fallback.id)
    expect(useProjectStore.getState().projects).toEqual([fallback])
  })

  it("falls back to an in-memory loaded store when persistence is unavailable", async () => {
    getAllProjects.mockRejectedValueOnce(new Error("indexeddb unavailable"))

    await useProjectStore.getState().load()

    expect(useProjectStore.getState().loaded).toBe(true)
    expect(useProjectStore.getState().projects).toEqual([])
    expect(ensureDefaultProject).not.toHaveBeenCalled()
  })
})

describe("createProject dispatch", () => {
  it("fires dispatchProjectCreate after the project lands in state", () => {
    const project = useProjectStore.getState().createProject({ name: "Alpha" })
    expect(useProjectStore.getState().projects).toHaveLength(1)
    expect(dispatchProjectCreate).toHaveBeenCalledTimes(1)
    expect(dispatchProjectCreate).toHaveBeenCalledWith(project)
  })

  it("normalizes blank names and clones initial tags", () => {
    const project = useProjectStore
      .getState()
      .createProject({ name: "  ", tags: ["alpha", "beta"] })

    expect(project.name).toBe("New Project")
    expect(project.tags).toEqual(["alpha", "beta"])
  })
})

describe("updateProject dispatch", () => {
  it("fires dispatchProjectUpdate with the updated project and the patch", () => {
    const project = useProjectStore.getState().createProject({ name: "Alpha" })
    dispatchProjectUpdate.mockClear()
    useProjectStore.getState().updateProject(project.id, { description: "added" })
    expect(dispatchProjectUpdate).toHaveBeenCalledTimes(1)
    const [updated, patch] = dispatchProjectUpdate.mock.calls[0]
    expect((updated as { id: string }).id).toBe(project.id)
    expect((updated as { description?: string }).description).toBe("added")
    expect(patch).toEqual({ description: "added" })
  })

  it("does not fire dispatchProjectUpdate when the project id is unknown", () => {
    useProjectStore.getState().updateProject("missing", { description: "x" })
    expect(dispatchProjectUpdate).not.toHaveBeenCalled()
  })
})

describe("deleteProject dispatch", () => {
  it("fires dispatchProjectDelete with the deleted project id", () => {
    const project = useProjectStore.getState().createProject({ name: "Alpha" })
    dispatchProjectDelete.mockClear()
    useProjectStore.getState().deleteProject(project.id)
    expect(dispatchProjectDelete).toHaveBeenCalledWith(project.id)
  })

  it("does not fire dispatchProjectDelete when the id does not exist", () => {
    useProjectStore.getState().deleteProject("missing")
    expect(dispatchProjectDelete).not.toHaveBeenCalled()
  })
})

describe("setActiveProject dispatch", () => {
  it("fires dispatchProjectSwitch when activating a real project", () => {
    const project = useProjectStore.getState().createProject({ name: "Alpha" })
    useProjectStore.getState().setActiveProject(project.id)
    expect(dispatchProjectSwitch).toHaveBeenCalledWith(project.id, null)
  })

  it("fires dispatchProjectSwitch when clearing the active project", () => {
    const project = useProjectStore.getState().createProject({ name: "Alpha" })
    useProjectStore.getState().setActiveProject(project.id)
    dispatchProjectSwitch.mockClear()
    useProjectStore.getState().setActiveProject(null)
    expect(dispatchProjectSwitch).toHaveBeenCalledWith(null, project.id)
  })

  it("fires dispatchProjectSwitch even when the id is not in the projects list yet", () => {
    useProjectStore.getState().setActiveProject("pending-id")
    expect(dispatchProjectSwitch).toHaveBeenCalledWith("pending-id", null)
  })
})

describe("addKnowledgeFile dispatch", () => {
  it("fires dispatchKnowledgeFileAdd after the file is appended", () => {
    const project = useProjectStore.getState().createProject({ name: "Alpha" })
    dispatchKnowledgeFileAdd.mockClear()
    useProjectStore.getState().addKnowledgeFile(project.id, {
      name: "n",
      type: "text",
      content: "hello",
      size: 5,
    } as never)
    expect(dispatchKnowledgeFileAdd).toHaveBeenCalledTimes(1)
    const [pid, file] = dispatchKnowledgeFileAdd.mock.calls[0]
    expect(pid).toBe(project.id)
    expect((file as { name: string }).name).toBe("n")
    expect((file as { id: string }).id).toMatch(/^kbfile-/)
  })

  it("does not fire dispatchKnowledgeFileAdd when the project id is unknown", () => {
    useProjectStore.getState().addKnowledgeFile("missing", {
      name: "n",
      type: "text",
      content: "x",
      size: 1,
    } as never)
    expect(dispatchKnowledgeFileAdd).not.toHaveBeenCalled()
  })
})

describe("removeKnowledgeFile dispatch", () => {
  it("fires dispatchKnowledgeFileRemove with project + file id", () => {
    const project = useProjectStore.getState().createProject({ name: "Alpha" })
    useProjectStore.getState().addKnowledgeFile(project.id, {
      name: "n",
      type: "text",
      content: "hello",
      size: 5,
    } as never)
    const fileId = useProjectStore.getState().projects[0].knowledgeBase[0].id
    dispatchKnowledgeFileRemove.mockClear()
    useProjectStore.getState().removeKnowledgeFile(project.id, fileId)
    expect(dispatchKnowledgeFileRemove).toHaveBeenCalledWith(project.id, fileId)
  })

  it("does not fire when the file id is unknown", () => {
    const project = useProjectStore.getState().createProject({ name: "Alpha" })
    dispatchKnowledgeFileRemove.mockClear()
    useProjectStore.getState().removeKnowledgeFile(project.id, "missing-file")
    expect(dispatchKnowledgeFileRemove).not.toHaveBeenCalled()
  })
})

describe("addSessionToProject dispatch", () => {
  it("fires dispatchSessionLinked with project + session id", () => {
    const project = useProjectStore.getState().createProject({ name: "Alpha" })
    useProjectStore.getState().addSessionToProject(project.id, "session-1")
    expect(dispatchSessionLinked).toHaveBeenCalledWith(project.id, "session-1")
  })

  it("does not re-fire when the session is already linked", () => {
    const project = useProjectStore.getState().createProject({ name: "Alpha" })
    useProjectStore.getState().addSessionToProject(project.id, "session-1")
    dispatchSessionLinked.mockClear()
    useProjectStore.getState().addSessionToProject(project.id, "session-1")
    expect(dispatchSessionLinked).not.toHaveBeenCalled()
  })
})

describe("removeSessionFromProject dispatch", () => {
  it("fires dispatchSessionUnlinked when the session was actually linked", () => {
    const project = useProjectStore.getState().createProject({ name: "Alpha" })
    useProjectStore.getState().addSessionToProject(project.id, "session-1")
    dispatchSessionUnlinked.mockClear()
    useProjectStore.getState().removeSessionFromProject(project.id, "session-1")
    expect(dispatchSessionUnlinked).toHaveBeenCalledWith(project.id, "session-1")
  })

  it("does not fire when the session was never linked", () => {
    const project = useProjectStore.getState().createProject({ name: "Alpha" })
    useProjectStore.getState().removeSessionFromProject(project.id, "missing-session")
    expect(dispatchSessionUnlinked).not.toHaveBeenCalled()
  })
})

describe("archive, knowledge file, and tag mutations", () => {
  it("archives and unarchives a project", () => {
    const project = useProjectStore.getState().createProject({ name: "Archive me" })

    useProjectStore.getState().archiveProject(project.id)
    expect(useProjectStore.getState().projects.find((p) => p.id === project.id)?.isArchived).toBe(
      true
    )

    useProjectStore.getState().unarchiveProject(project.id)
    expect(useProjectStore.getState().projects.find((p) => p.id === project.id)?.isArchived).toBe(
      false
    )
  })

  it("updates a knowledge file in place", () => {
    const project = useProjectStore.getState().createProject({ name: "Knowledge" })
    useProjectStore.getState().addKnowledgeFile(project.id, {
      name: "note",
      type: "text",
      content: "old",
      size: 3,
    } as never)
    const fileId = useProjectStore.getState().projects[0].knowledgeBase[0].id

    useProjectStore.getState().updateKnowledgeFile(project.id, fileId, "new content")

    const file = useProjectStore.getState().projects[0].knowledgeBase[0]
    expect(file.content).toBe("new content")
    expect(file.size).toBe("new content".length)
  })

  it("adds and removes tags without duplicating existing tags", () => {
    const project = useProjectStore.getState().createProject({ name: "Tags" })

    useProjectStore.getState().addTag(project.id, "alpha")
    useProjectStore.getState().addTag(project.id, "alpha")
    expect(useProjectStore.getState().projects[0].tags).toEqual(["alpha"])

    useProjectStore.getState().removeTag(project.id, "alpha")
    expect(useProjectStore.getState().projects[0].tags).toEqual([])
  })

  it("preserves non-target projects across scoped mutations", () => {
    const untouched = useProjectStore.getState().createProject({ name: "Untouched" })
    const target = useProjectStore.getState().createProject({ name: "Target" })
    const expectUntouchedProjectToSurvive = (mutate: () => void) => {
      const before = useProjectStore.getState().projects.find((p) => p.id === untouched.id)
      mutate()
      const after = useProjectStore.getState().projects.find((p) => p.id === untouched.id)
      expect(after).toBe(before)
    }

    expectUntouchedProjectToSurvive(() => useProjectStore.getState().archiveProject(target.id))
    expectUntouchedProjectToSurvive(() => useProjectStore.getState().unarchiveProject(target.id))

    expectUntouchedProjectToSurvive(() =>
      useProjectStore.getState().addKnowledgeFile(target.id, {
        name: "first",
        type: "text",
        content: "one",
        size: 3,
      } as never)
    )
    useProjectStore.getState().addKnowledgeFile(target.id, {
      name: "second",
      type: "text",
      content: "two",
      size: 3,
    } as never)
    const [firstFile] = useProjectStore
      .getState()
      .projects.find((p) => p.id === target.id)!.knowledgeBase

    expectUntouchedProjectToSurvive(() =>
      useProjectStore.getState().updateKnowledgeFile(target.id, firstFile.id, "updated")
    )
    expectUntouchedProjectToSurvive(() =>
      useProjectStore.getState().removeKnowledgeFile(target.id, firstFile.id)
    )
    expectUntouchedProjectToSurvive(() =>
      useProjectStore.getState().addSessionToProject(target.id, "session-1")
    )
    expectUntouchedProjectToSurvive(() =>
      useProjectStore.getState().removeSessionFromProject(target.id, "session-1")
    )
    expectUntouchedProjectToSurvive(() => useProjectStore.getState().addTag(target.id, "alpha"))
    expectUntouchedProjectToSurvive(() => useProjectStore.getState().removeTag(target.id, "alpha"))

    expect(useProjectStore.getState().projects.find((p) => p.id === untouched.id)).toEqual(
      expect.objectContaining({ name: "Untouched", knowledgeBase: [], sessionIds: [] })
    )
  })

  it("removes tags from projects that do not yet have a tag list", () => {
    const project = useProjectStore.getState().createProject({ name: "No tags" })

    useProjectStore.getState().removeTag(project.id, "missing")

    expect(useProjectStore.getState().projects[0].tags).toEqual([])
  })
})

import { primaryRootOf, additionalDirsOf } from "@/lib/workspace/roots"

describe("project-store roots", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  })

  it("createProject seeds roots from rootDir + additionalDirs and syncs mirrors", () => {
    const p = useProjectStore
      .getState()
      .createProject({ name: "W", rootDir: "/a", additionalDirs: ["/b"] })
    expect(primaryRootOf(p)?.path).toBe("/a")
    expect(additionalDirsOf(p)).toEqual(["/b"])
    expect(p.rootDir).toBe("/a")
    expect(p.additionalDirs).toEqual(["/b"])
  })

  it("createProject with no dirs yields empty roots", () => {
    const p = useProjectStore.getState().createProject({ name: "W" })
    expect(p.roots).toEqual([])
    expect(p.rootDir).toBeUndefined()
  })

  it("createProject accepts an explicit roots array", () => {
    const p = useProjectStore.getState().createProject({
      name: "W",
      roots: [
        { id: "r1", path: "/x" },
        { id: "r2", path: "/y", isPrimary: true },
      ],
    })
    expect(primaryRootOf(p)?.path).toBe("/y")
    expect(p.rootDir).toBe("/y")
  })

  it("updateProject with roots recomputes the derived mirrors", () => {
    const p = useProjectStore.getState().createProject({ name: "W", rootDir: "/a" })
    useProjectStore.getState().updateProject(p.id, {
      roots: [
        { id: "r1", path: "/x", isPrimary: true },
        { id: "r2", path: "/y" },
      ],
    })
    const updated = useProjectStore.getState().projects.find((q) => q.id === p.id)!
    expect(updated.rootDir).toBe("/x")
    expect(updated.additionalDirs).toEqual(["/y"])
  })

  it("updateProject with legacy rootDir rebuilds roots", () => {
    const p = useProjectStore.getState().createProject({ name: "W" })
    useProjectStore.getState().updateProject(p.id, { rootDir: "/z" })
    const updated = useProjectStore.getState().projects.find((q) => q.id === p.id)!
    expect(primaryRootOf(updated)?.path).toBe("/z")
  })

  it("updateProject with legacy additionalDirs preserves the existing primary root", () => {
    const p = useProjectStore.getState().createProject({ name: "W", rootDir: "/root" })
    useProjectStore.getState().updateProject(p.id, { additionalDirs: ["/extra"] })
    const updated = useProjectStore.getState().projects.find((q) => q.id === p.id)!
    expect(primaryRootOf(updated)?.path).toBe("/root")
    expect(additionalDirsOf(updated)).toEqual(["/extra"])
  })
  describe("removing a workspace", () => {
    it("hands its contents to Default by default, destroying nothing", async () => {
      // Removing a workspace is not the same decision as destroying the
      // conversations that were in it.
      const project = projectFixture({ id: "p_gone" })
      useProjectStore.setState({ projects: [project], loaded: true })

      useProjectStore.getState().deleteProject("p_gone")
      await Promise.resolve()

      expect(detachProjectContents).toHaveBeenCalledWith("p_gone")
      expect(deleteProjectCascade).not.toHaveBeenCalled()
    })

    it("destroys the contents only when asked to", async () => {
      const project = projectFixture({ id: "p_gone" })
      useProjectStore.setState({ projects: [project], loaded: true })

      useProjectStore.getState().deleteProject("p_gone", "delete-data")
      await Promise.resolve()

      expect(deleteProjectCascade).toHaveBeenCalledWith("p_gone")
      expect(detachProjectContents).not.toHaveBeenCalled()
    })
  })
})
