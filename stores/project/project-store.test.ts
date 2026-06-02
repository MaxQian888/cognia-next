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

import { useProjectStore } from "./project-store"

beforeEach(() => {
  useProjectStore.setState({ projects: [], activeProjectId: null })
  dispatchProjectCreate.mockClear()
  dispatchProjectUpdate.mockClear()
  dispatchProjectDelete.mockClear()
  dispatchProjectSwitch.mockClear()
  dispatchKnowledgeFileAdd.mockClear()
  dispatchKnowledgeFileRemove.mockClear()
  dispatchSessionLinked.mockClear()
  dispatchSessionUnlinked.mockClear()
})

describe("createProject dispatch", () => {
  it("fires dispatchProjectCreate after the project lands in state", () => {
    const project = useProjectStore.getState().createProject({ name: "Alpha" })
    expect(useProjectStore.getState().projects).toHaveLength(1)
    expect(dispatchProjectCreate).toHaveBeenCalledTimes(1)
    expect(dispatchProjectCreate).toHaveBeenCalledWith(project)
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
})
