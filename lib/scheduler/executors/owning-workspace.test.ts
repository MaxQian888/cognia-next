import type { AppSettings } from "@cognia/agent-config-types"
import type { Project } from "@/types"

const getAllProjectsMock = jest.fn()
const warnMock = jest.fn()
const isWorkspaceTrustedMock = jest.fn(async (_path: string) => true)
const hostEnforcesMock = jest.fn(() => true)

jest.mock("@/lib/db/projects", () => ({
  getAllProjects: () => getAllProjectsMock(),
}))
jest.mock("@/lib/db/trusted-workspaces", () => ({
  isWorkspaceTrusted: (path: string) => isWorkspaceTrustedMock(path),
}))
jest.mock("../host-support", () => ({
  hostEnforcesWorkspaceTrust: () => hostEnforcesMock(),
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

import { loadOwningWorkspace, resolveScheduledWorkspaceTrust } from "./owning-workspace"

function makeProject(id: string): Project {
  return { id, name: id, rootPath: `/repos/${id}` } as unknown as Project
}

function rootedProject(id: string, path: string): Project {
  return {
    id,
    name: id,
    roots: [{ id: "r1", path, isPrimary: true }],
  } as unknown as Project
}

beforeEach(() => {
  getAllProjectsMock.mockReset()
  warnMock.mockReset()
  isWorkspaceTrustedMock.mockReset().mockResolvedValue(true)
  hostEnforcesMock.mockReset().mockReturnValue(true)
})

describe("loadOwningWorkspace", () => {
  it("resolves the workspace the run names", async () => {
    const owning = makeProject("proj-owning")
    getAllProjectsMock.mockResolvedValue([makeProject("proj-other"), owning])
    await expect(loadOwningWorkspace("proj-owning", { taskId: "t1" })).resolves.toEqual({
      project: owning,
      readFailed: false,
    })
  })

  it("does not read the workspaces when the run names none", async () => {
    const none = { project: null, readFailed: false }
    await expect(loadOwningWorkspace(null, { taskId: "t1" })).resolves.toEqual(none)
    await expect(loadOwningWorkspace(undefined, { taskId: "t1" })).resolves.toEqual(none)
    await expect(loadOwningWorkspace("", { taskId: "t1" })).resolves.toEqual(none)
    expect(getAllProjectsMock).not.toHaveBeenCalled()
  })

  it("resolves a deleted workspace to null rather than any other one", async () => {
    getAllProjectsMock.mockResolvedValue([makeProject("proj-other")])
    await expect(loadOwningWorkspace("proj-gone", { taskId: "t1" })).resolves.toEqual({
      project: null,
      readFailed: false,
    })
    expect(warnMock).not.toHaveBeenCalled()
  })

  it("reports a failed read, and says why, instead of passing it off as no workspace", async () => {
    getAllProjectsMock.mockRejectedValue(new Error("db closed"))
    await expect(
      loadOwningWorkspace("proj-owning", { goalId: "g1", sessionId: "s1" })
    ).resolves.toEqual({ project: null, readFailed: true })
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

describe("resolveScheduledWorkspaceTrust", () => {
  const settings = null as AppSettings | null

  it("restricts an untrusted workspace and names its roots", async () => {
    isWorkspaceTrustedMock.mockResolvedValue(false)
    const trust = await resolveScheduledWorkspaceTrust(
      { project: rootedProject("p", "/repo"), readFailed: false },
      settings,
      { taskId: "t1" }
    )
    expect(trust).toEqual({ restricted: true, trustedRoots: [], untrustedRoots: ["/repo"] })
  })

  it("fails closed when the owning workspace could not be read", async () => {
    const trust = await resolveScheduledWorkspaceTrust(
      { project: null, readFailed: true },
      settings,
      { taskId: "t1" }
    )
    expect(trust).toEqual({
      restricted: true,
      trustedRoots: [],
      untrustedRoots: [],
      unverified: true,
    })
    expect(isWorkspaceTrustedMock).not.toHaveBeenCalled()
  })

  it("does not restrict a failed read where trust does not apply", async () => {
    hostEnforcesMock.mockReturnValue(false)
    await expect(
      resolveScheduledWorkspaceTrust({ project: null, readFailed: true }, settings, {})
    ).resolves.toMatchObject({ restricted: false })

    hostEnforcesMock.mockReturnValue(true)
    await expect(
      resolveScheduledWorkspaceTrust(
        { project: null, readFailed: true },
        { workspaceTrust: { enabled: false } } as unknown as AppSettings,
        {}
      )
    ).resolves.toMatchObject({ restricted: false })
  })

  it("fails closed when the trust ledger cannot be read", async () => {
    isWorkspaceTrustedMock.mockRejectedValue(new Error("db closed"))
    const trust = await resolveScheduledWorkspaceTrust(
      { project: rootedProject("p", "/repo"), readFailed: false },
      settings,
      { taskId: "t1" }
    )
    expect(trust).toEqual({
      restricted: true,
      trustedRoots: [],
      untrustedRoots: ["/repo"],
      unverified: true,
    })
  })

  it("leaves a run with no workspace ungated", async () => {
    await expect(
      resolveScheduledWorkspaceTrust({ project: null, readFailed: false }, settings, {})
    ).resolves.toEqual({ restricted: false, trustedRoots: [], untrustedRoots: [] })
  })
})
