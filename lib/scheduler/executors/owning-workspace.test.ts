import type { Project } from "@/types"

const getAllProjectsMock = jest.fn()
const warnMock = jest.fn()

jest.mock("@/lib/db/projects", () => ({
  getAllProjects: () => getAllProjectsMock(),
}))
jest.mock("@cognia/logging", () => {
  const stub = {
    info: jest.fn(),
    warn: (...a: unknown[]) => warnMock(...a),
    error: jest.fn(),
    debug: jest.fn(),
  }
  return { loggers: { scheduler: stub } }
})

import { loadOwningWorkspace } from "./owning-workspace"

function makeProject(id: string): Project {
  return { id, name: id, rootPath: `/repos/${id}` } as unknown as Project
}

beforeEach(() => {
  getAllProjectsMock.mockReset()
  warnMock.mockReset()
})

describe("loadOwningWorkspace", () => {
  it("resolves the workspace the run names", async () => {
    const owning = makeProject("proj-owning")
    getAllProjectsMock.mockResolvedValue([makeProject("proj-other"), owning])
    await expect(loadOwningWorkspace("proj-owning", { taskId: "t1" })).resolves.toBe(owning)
  })

  it("does not read the workspaces when the run names none", async () => {
    await expect(loadOwningWorkspace(null, { taskId: "t1" })).resolves.toBeNull()
    await expect(loadOwningWorkspace(undefined, { taskId: "t1" })).resolves.toBeNull()
    await expect(loadOwningWorkspace("", { taskId: "t1" })).resolves.toBeNull()
    expect(getAllProjectsMock).not.toHaveBeenCalled()
  })

  it("resolves a deleted workspace to null rather than any other one", async () => {
    getAllProjectsMock.mockResolvedValue([makeProject("proj-other")])
    await expect(loadOwningWorkspace("proj-gone", { taskId: "t1" })).resolves.toBeNull()
    expect(warnMock).not.toHaveBeenCalled()
  })

  it("runs without a workspace and says why when the read fails", async () => {
    getAllProjectsMock.mockRejectedValue(new Error("db closed"))
    await expect(
      loadOwningWorkspace("proj-owning", { goalId: "g1", sessionId: "s1" })
    ).resolves.toBeNull()
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining("owning workspace"),
      expect.objectContaining({
        goalId: "g1",
        sessionId: "s1",
        projectId: "proj-owning",
        err: "Error: db closed",
      })
    )
  })
})
