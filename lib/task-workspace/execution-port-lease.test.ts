let desktop = true
jest.mock("@/lib/tauri", () => ({ isTauri: () => desktop }))
jest.mock("./client", () => ({
  ensureSubjectPortLease: jest.fn(),
  ensureWorkspacePortLease: jest.fn(),
  resolveWorkspacePortLeaseEnsure: jest.fn(),
  releaseSubjectPortLeases: jest.fn(),
}))
jest.mock("./user-action", () => ({ runWorkspaceUserAction: jest.fn() }))
const projects: Array<{ id: string; roots: Array<{ id: string; path: string }> }> = []
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ projects }) },
}))
const getAllProjects = jest.fn()
jest.mock("@/lib/db/projects", () => ({ getAllProjects: () => getAllProjects() }))

import { ensureExecutionPortLease, releaseProjectPortLeases } from "./execution-port-lease"
import {
  ensureSubjectPortLease,
  ensureWorkspacePortLease,
  resolveWorkspacePortLeaseEnsure,
  releaseSubjectPortLeases,
} from "./client"
import { createSessionExecutionContext } from "./session-execution-context"
import { runWorkspaceUserAction } from "./user-action"

const project = {
  id: "project-1",
  roots: [
    { id: "primary", path: "/repo", isPrimary: true },
    { id: "other", path: "/other" },
  ],
}
const lease = { leaseId: "lease-1" }

beforeEach(() => {
  jest.resetAllMocks()
  jest.mocked(runWorkspaceUserAction).mockImplementation(async (_command, operation) => operation())
  desktop = true
  projects.length = 0
  getAllProjects.mockResolvedValue([])
  jest.mocked(ensureSubjectPortLease).mockResolvedValue(lease as never)
  jest.mocked(ensureWorkspacePortLease).mockResolvedValue(lease as never)
  jest.mocked(resolveWorkspacePortLeaseEnsure).mockResolvedValue(lease as never)
})

it("registers only the executing project root even when another root is offline", async () => {
  jest.mocked(ensureSubjectPortLease).mockImplementation(async (input) => {
    if (input.root === "/other") throw new Error("offline root")
    return lease as never
  })
  await expect(ensureExecutionPortLease({ project, cwd: "/repo/src" })).resolves.toBe(lease)
  expect(ensureSubjectPortLease).toHaveBeenNthCalledWith(1, {
    kind: "project-root",
    key: project.id,
    root: "/repo",
    namespace: undefined,
  })
  expect(ensureSubjectPortLease).toHaveBeenCalledTimes(1)
  expect(resolveWorkspacePortLeaseEnsure).toHaveBeenCalledWith("/repo/src", undefined, undefined)
  expect(jest.mocked(runWorkspaceUserAction).mock.calls.map(([command]) => command)).toEqual([
    "task_workspace_port_lease_resolve_ensure",
    "task_workspace_port_lease_subject_ensure",
    "task_workspace_port_lease_resolve_ensure",
  ])
  expect(jest.mocked(ensureSubjectPortLease).mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(resolveWorkspacePortLeaseEnsure).mock.invocationCallOrder[1]
  )
})

it("selects the longest containing project root for a nested checkout", async () => {
  const nestedProject = {
    ...project,
    roots: [...project.roots, { id: "nested", path: "/repo/packages/app" }],
  }
  await ensureExecutionPortLease({ project: nestedProject, cwd: "/repo/packages/app/src" })
  expect(ensureSubjectPortLease).toHaveBeenCalledTimes(1)
  expect(ensureSubjectPortLease).toHaveBeenCalledWith({
    kind: "project-root",
    key: project.id,
    root: "/repo/packages/app",
    namespace: undefined,
  })
})

it("does not register a project root when cwd is outside its roots or absent", async () => {
  await ensureExecutionPortLease({ project, cwd: "/repo-other" })
  await expect(ensureExecutionPortLease({ project })).resolves.toBeNull()
  expect(ensureSubjectPortLease).not.toHaveBeenCalled()
})

it("loads durable project roots when execution precedes store hydration", async () => {
  getAllProjects.mockResolvedValue([project])
  await ensureExecutionPortLease({ projectId: project.id, cwd: "/repo" })
  expect(getAllProjects).toHaveBeenCalledTimes(1)
  expect(ensureSubjectPortLease).toHaveBeenCalledTimes(1)
})

it("uses registry ids from the most specific execution root", async () => {
  const executionContext = createSessionExecutionContext({
    sessionId: "session-1",
    projectId: project.id,
    projectRoot: "/worktree",
    requestedLocation: "managedWorktree",
    isGitRepository: true,
    now: 1,
    rootLeases: [
      { logicalRootId: "a", role: "primary", aliasPath: "/worktree", workspaceId: "registry-a" },
      {
        logicalRootId: "b",
        role: "additional",
        aliasPath: "/worktree/nested",
        workspaceId: "registry-b",
      },
    ],
  })
  await ensureExecutionPortLease({
    cwd: "/worktree/nested/src",
    project,
    executionContext,
    namespace: "container:one",
  })
  expect(ensureWorkspacePortLease).toHaveBeenCalledWith("registry-b", "container:one")
  expect(ensureSubjectPortLease).not.toHaveBeenCalled()
  expect(getAllProjects).not.toHaveBeenCalled()
  expect(resolveWorkspacePortLeaseEnsure).toHaveBeenCalledWith(
    "/worktree/nested/src",
    undefined,
    "container:one"
  )
})

it("lets canonical host resolution override a lexical registry-root match", async () => {
  const executionContext = createSessionExecutionContext({
    sessionId: "session-1",
    projectId: project.id,
    projectRoot: "/worktree",
    requestedLocation: "managedWorktree",
    isGitRepository: true,
    now: 1,
    rootLeases: [
      { logicalRootId: "a", role: "primary", aliasPath: "/worktree", workspaceId: "registry-a" },
    ],
  })
  const canonicalLease = { leaseId: "outside-symlink-target" }
  jest.mocked(resolveWorkspacePortLeaseEnsure).mockResolvedValueOnce(canonicalLease as never)
  await expect(
    ensureExecutionPortLease({ cwd: "/worktree/outside-symlink", executionContext })
  ).resolves.toBe(canonicalLease)
  expect(ensureWorkspacePortLease).toHaveBeenCalledWith("registry-a", undefined)
  expect(resolveWorkspacePortLeaseEnsure).toHaveBeenCalledWith(
    "/worktree/outside-symlink",
    undefined,
    undefined
  )
})

it("ensures an explicit registry identity even without a cwd", async () => {
  await expect(
    ensureExecutionPortLease({ workspaceId: "registry-explicit", namespace: "remote:one", project })
  ).resolves.toBe(lease)
  expect(ensureWorkspacePortLease).toHaveBeenCalledWith("registry-explicit", "remote:one")
  expect(runWorkspaceUserAction).toHaveBeenCalledWith(
    "task_workspace_port_lease_ensure",
    expect.any(Function)
  )
  expect(ensureSubjectPortLease).not.toHaveBeenCalled()
  expect(resolveWorkspacePortLeaseEnsure).not.toHaveBeenCalled()
})

it("registers desktop sessions by session id, never by their portable workspace id", async () => {
  const executionContext = createSessionExecutionContext({
    sessionId: "session-1",
    projectId: "",
    projectRoot: "/scratch",
    managedWorkspaceId: "portable-id",
    managedWorkspaceRoot: "/scratch",
    requestedLocation: "managedWorktree",
    isGitRepository: false,
    now: 1,
  })
  await ensureExecutionPortLease({
    cwd: "/scratch/src",
    sessionId: "session-1",
    executionContext,
    project,
  })
  expect(ensureSubjectPortLease).toHaveBeenCalledTimes(1)
  expect(ensureSubjectPortLease).toHaveBeenCalledWith({
    kind: "desktop-session",
    key: "session-1",
    root: "/scratch",
    namespace: undefined,
  })
  expect(ensureWorkspacePortLease).not.toHaveBeenCalled()
  jest.mocked(ensureSubjectPortLease).mockClear()
  await ensureExecutionPortLease({
    cwd: "/scratch-other",
    sessionId: "session-1",
    executionContext,
  })
  expect(ensureSubjectPortLease).not.toHaveBeenCalled()
})

it("trusts host-resolved registry identity before loading project roots", async () => {
  const resolvedLease = { ...lease, subjectKind: "registry", registryWorkspaceId: "registry-1" }
  jest.mocked(resolveWorkspacePortLeaseEnsure).mockResolvedValueOnce(resolvedLease as never)
  getAllProjects.mockRejectedValueOnce(new Error("project checkout offline"))
  await expect(
    ensureExecutionPortLease({ projectId: project.id, cwd: "/repo/.worktree/src" })
  ).resolves.toBe(resolvedLease)
  expect(ensureSubjectPortLease).not.toHaveBeenCalled()
  expect(getAllProjects).not.toHaveBeenCalled()
})

it("attaches project ownership when a converted folder retains a desktop-session lease", async () => {
  const sharedLease = { ...lease, subjectKind: "desktop-session", registryWorkspaceId: null }
  jest.mocked(resolveWorkspacePortLeaseEnsure).mockResolvedValue(sharedLease as never)
  await expect(ensureExecutionPortLease({ project, cwd: "/repo/src" })).resolves.toBe(sharedLease)
  expect(ensureSubjectPortLease).toHaveBeenCalledTimes(1)
  expect(ensureSubjectPortLease).toHaveBeenCalledWith({
    kind: "project-root",
    key: project.id,
    root: "/repo",
    namespace: undefined,
  })
  expect(resolveWorkspacePortLeaseEnsure).toHaveBeenCalledTimes(2)
})

it("does not allocate or release in web mode", async () => {
  desktop = false
  await expect(ensureExecutionPortLease({ project, cwd: "/repo" })).resolves.toBeNull()
  await releaseProjectPortLeases(project.id)
  expect(ensureSubjectPortLease).not.toHaveBeenCalled()
  expect(resolveWorkspacePortLeaseEnsure).not.toHaveBeenCalled()
  expect(releaseSubjectPortLeases).not.toHaveBeenCalled()
  expect(runWorkspaceUserAction).not.toHaveBeenCalled()
})

it("propagates allocation failures unchanged and never resolves past the failed registration", async () => {
  const error = new Error("portRangeStart/portRangeEnd/portBlockSize exhausted")
  jest.mocked(ensureSubjectPortLease).mockRejectedValueOnce(error)
  await expect(ensureExecutionPortLease({ project, cwd: "/repo" })).rejects.toBe(error)
  expect(resolveWorkspacePortLeaseEnsure).toHaveBeenCalledTimes(1)
})

it("releases all project-root subjects and propagates refusals", async () => {
  await releaseProjectPortLeases(project.id, "host-loopback")
  expect(releaseSubjectPortLeases).toHaveBeenCalledWith({
    kind: "project-root",
    key: project.id,
    namespace: "host-loopback",
  })
  expect(runWorkspaceUserAction).toHaveBeenCalledWith(
    "task_workspace_port_lease_subject_release",
    expect.any(Function)
  )
  const error = new Error("Occupied: 41000")
  jest.mocked(releaseSubjectPortLeases).mockRejectedValueOnce(error)
  await expect(releaseProjectPortLeases(project.id)).rejects.toBe(error)
})

it("does not send a mutation when approval fails", async () => {
  const error = new Error("approval unavailable")
  jest.mocked(runWorkspaceUserAction).mockRejectedValueOnce(error)
  await expect(ensureExecutionPortLease({ project, cwd: "/repo" })).rejects.toBe(error)
  expect(ensureSubjectPortLease).not.toHaveBeenCalled()
  expect(resolveWorkspacePortLeaseEnsure).not.toHaveBeenCalled()
})
