import { collectWorkspaceChanges, undoWorkspaceChanges } from "./workspace-changes"
import type { GitStatus } from "@/types/git"

const status: GitStatus = {
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  merge: [
    { path: "conflict.ts", origPath: null, status: "conflicted", staged: false, group: "merge" },
  ],
  staged: [
    {
      path: "renamed.ts",
      origPath: "original.ts",
      status: "renamed",
      staged: true,
      group: "staged",
    },
    { path: "added.ts", origPath: null, status: "added", staged: true, group: "staged" },
  ],
  changes: [
    {
      path: "renamed.ts",
      origPath: null,
      status: "modified",
      staged: false,
      group: "changes",
    },
    {
      path: "scratch.txt",
      origPath: null,
      status: "untracked",
      staged: false,
      group: "changes",
    },
  ],
  isRebasing: false,
  isMerging: true,
}

describe("collectWorkspaceChanges", () => {
  it("deduplicates staged, unstaged, and merge rows by final path", () => {
    const files = collectWorkspaceChanges(status)

    expect(files.map((file) => file.path)).toEqual([
      "conflict.ts",
      "renamed.ts",
      "added.ts",
      "scratch.txt",
    ])
    expect(files.find((file) => file.path === "renamed.ts")?.origPaths).toEqual(["original.ts"])
  })
})

describe("undoWorkspaceChanges", () => {
  it("unstages tracked and original rename paths before discarding every new and old path", async () => {
    const calls: string[] = []
    const unstage = jest.fn(async (_root: string, paths: string[]) => {
      calls.push(`unstage:${paths.join(",")}`)
    })
    const discard = jest.fn(async (_root: string, paths: string[]) => {
      calls.push(`discard:${paths.join(",")}`)
    })
    const refresh = jest.fn(async () => {
      calls.push("refresh")
    })

    await undoWorkspaceChanges("/repo", status, { unstage, discard, refresh })

    expect(calls).toEqual([
      "unstage:conflict.ts,renamed.ts,original.ts,added.ts",
      "discard:conflict.ts,renamed.ts,original.ts,added.ts,scratch.txt",
      "refresh",
    ])
  })

  it("stops after a failure and still refreshes current status", async () => {
    const error = new Error("unstage failed")
    const unstage = jest.fn().mockRejectedValue(error)
    const discard = jest.fn()
    const refresh = jest.fn().mockResolvedValue(undefined)

    await expect(undoWorkspaceChanges("/repo", status, { unstage, discard, refresh })).rejects.toBe(
      error
    )

    expect(discard).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledWith("/repo")
  })

  it("stops when discard fails and still refreshes current status", async () => {
    const error = new Error("discard failed")
    const unstage = jest.fn().mockResolvedValue(undefined)
    const discard = jest.fn().mockRejectedValue(error)
    const refresh = jest.fn().mockResolvedValue(undefined)

    await expect(undoWorkspaceChanges("/repo", status, { unstage, discard, refresh })).rejects.toBe(
      error
    )

    expect(unstage).toHaveBeenCalledTimes(1)
    expect(discard).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith("/repo")
  })

  it("rejects when the final refresh fails after successful operations", async () => {
    const error = new Error("refresh failed")
    const unstage = jest.fn().mockResolvedValue(undefined)
    const discard = jest.fn().mockResolvedValue(undefined)
    const refresh = jest.fn().mockRejectedValue(error)

    await expect(undoWorkspaceChanges("/repo", status, { unstage, discard, refresh })).rejects.toBe(
      error
    )
  })

  it("preserves the operation error when refresh also fails", async () => {
    const operationError = new Error("discard failed")
    const refreshError = new Error("refresh failed")
    const unstage = jest.fn().mockResolvedValue(undefined)
    const discard = jest.fn().mockRejectedValue(operationError)
    const refresh = jest.fn().mockRejectedValue(refreshError)

    await expect(undoWorkspaceChanges("/repo", status, { unstage, discard, refresh })).rejects.toBe(
      operationError
    )
  })
})
