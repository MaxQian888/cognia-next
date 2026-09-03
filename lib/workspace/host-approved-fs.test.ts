const call = jest.fn()
const runWorkspaceUserAction = jest.fn()
const runGitUserAction = jest.fn()
const gitInit = jest.fn()
const getRuntimeSnapshot = jest.fn()
const listWorkspaceRoots = jest.fn()

jest.mock("@/lib/task-workspace/user-action", () => ({
  approvalAwareTransport: { call: (...args: unknown[]) => call(...args) },
  runWorkspaceUserAction: (...args: unknown[]) => runWorkspaceUserAction(...args),
}))
jest.mock("@/lib/git/commands", () => ({
  gitInit: (...args: unknown[]) => gitInit(...args),
  runGitUserAction: (...args: unknown[]) => runGitUserAction(...args),
}))
jest.mock("@/lib/files/workspace-fs", () => ({
  listWorkspaceRoots: () => listWorkspaceRoots(),
}))
jest.mock("@/lib/runtime/runtime-snapshot-store", () => ({
  getRuntimeSnapshot: () => getRuntimeSnapshot(),
}))

import {
  createApprovedWorkspaceDir,
  initApprovedGitRepository,
  remoteGitTargetForHostPath,
} from "./host-approved-fs"
import { parseGitTarget } from "@/lib/git/target"

const HEADLESS_ROOT = { path: "/srv/workspaces", source: "headless-workspaces-dir" as const }

describe("createApprovedWorkspaceDir", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    call.mockResolvedValue(null)
    runWorkspaceUserAction.mockImplementation((_command: string, operation: () => Promise<void>) =>
      operation()
    )
  })

  // The defect: `createWorkspaceDir` called `transport.call` bare, so the host
  // answered `interactive_approval_required` and no directory was made.
  it("binds a lease to the mkdir instead of calling it bare", async () => {
    await createApprovedWorkspaceDir("/srv/workspaces", "Cognia")

    expect(runWorkspaceUserAction).toHaveBeenCalledWith(
      "fs_create_workspace_dir",
      expect.any(Function)
    )
    expect(call).toHaveBeenCalledWith("fs_create_workspace_dir", {
      root: "/srv/workspaces",
      relPath: "Cognia",
    })
  })

  it("lets a refusal reach the caller, which renders it as create-failed", async () => {
    runWorkspaceUserAction.mockRejectedValue(new Error("workspace operation unavailable"))

    await expect(createApprovedWorkspaceDir("/srv/workspaces", "Cognia")).rejects.toThrow(
      "workspace operation unavailable"
    )
    expect(call).not.toHaveBeenCalled()
  })
})

describe("initApprovedGitRepository", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    gitInit.mockResolvedValue(undefined)
    runGitUserAction.mockImplementation((_command: string, operation: () => Promise<void>) =>
      operation()
    )
  })

  it("names the workspace by id, because a remote git_init refuses a path", async () => {
    getRuntimeSnapshot.mockReturnValue({ target: { kind: "companion" } })
    listWorkspaceRoots.mockResolvedValue([HEADLESS_ROOT])

    await initApprovedGitRepository("/srv/workspaces/Cognia")

    expect(runGitUserAction).toHaveBeenCalledWith("git_init", expect.any(Function))
    const [handed] = gitInit.mock.calls[0] as [string]
    expect(parseGitTarget(handed)).toEqual({
      kind: "remote",
      workspaceId: "Cognia",
      relativePath: "",
    })
  })

  // `runGitUserAction` gates on `isTauri()`, which is also false in the
  // headless brain. Asking that process for a lease would fail a call that
  // needs none, so the gate here is the presence of a client target.
  it("never asks for a lease when this shell is the execution host", async () => {
    getRuntimeSnapshot.mockReturnValue({ target: null })

    await initApprovedGitRepository("/srv/workspaces/Cognia")

    expect(runGitUserAction).not.toHaveBeenCalled()
    expect(gitInit).toHaveBeenCalledWith("/srv/workspaces/Cognia")
  })
})

describe("remoteGitTargetForHostPath", () => {
  it("takes the first segment under the root as the workspace id", async () => {
    await expect(
      remoteGitTargetForHostPath("/srv/workspaces/Cognia/packages/app", [HEADLESS_ROOT]).then(
        parseGitTarget
      )
    ).resolves.toEqual({ kind: "remote", workspaceId: "Cognia", relativePath: "packages/app" })
  })

  it("tolerates a trailing separator on either side", async () => {
    await expect(
      remoteGitTargetForHostPath("/srv/workspaces/Cognia/", [
        { path: "/srv/workspaces/", source: "headless-workspaces-dir" },
      ]).then(parseGitTarget)
    ).resolves.toEqual({ kind: "remote", workspaceId: "Cognia", relativePath: "" })
  })

  // A desktop Host names its roots by a registered root id the client is never
  // told, so deriving one would be a guess that fails at the Host instead.
  it("refuses a desktop-project root rather than guessing its id space", async () => {
    await expect(
      remoteGitTargetForHostPath("/Users/x/Projects/App", [
        { path: "/Users/x/Projects", source: "desktop-project" },
      ])
    ).rejects.toThrow("no headless workspaces root")
  })

  it("refuses the workspaces root itself", async () => {
    await expect(remoteGitTargetForHostPath("/srv/workspaces", [HEADLESS_ROOT])).rejects.toThrow(
      "workspaces root itself"
    )
  })
})
