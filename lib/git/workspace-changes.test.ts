import { collectWorkspaceChanges } from "./workspace-changes"
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
