import type { IssueProjectResource } from "@/types/issues"
import { isGithubImportBinding, isSyncedResource, resourceKey, resourceLabel } from "./bindings"

const repo: IssueProjectResource = { kind: "github-repo", repoFullName: "o/r", addedAt: 1 }
const importRepo: IssueProjectResource = { ...repo, sync: { mode: "import" } }
const root: IssueProjectResource = { kind: "workspace-root", rootId: "root-1", addedAt: 1 }
const tasklist: IssueProjectResource = {
  kind: "lark-tasklist",
  adapterId: "cai_1",
  tasklistGuid: "tl-1",
  name: "Team tasks",
  addedAt: 1,
}
const bitable: IssueProjectResource = {
  kind: "lark-bitable",
  adapterId: "cai_1",
  appToken: "app",
  tableId: "tbl",
  name: "Backlog table",
  fieldMap: { title: "Name" },
  addedAt: 1,
}

describe("resourceKey / resourceLabel", () => {
  it("gives every kind a distinct stable key and a printable label", () => {
    const keys = [repo, root, tasklist, bitable].map(resourceKey)
    expect(new Set(keys).size).toBe(4)
    expect(resourceKey(repo)).toBe("github-repo:o/r")
    expect(resourceLabel(repo)).toBe("o/r")
    expect(resourceLabel(root)).toBe("root-1")
    expect(resourceLabel(tasklist)).toBe("Team tasks")
    expect(resourceLabel(bitable)).toBe("Backlog table")
  })
})

describe("classification", () => {
  it("knows which resources feed the engine and which repos import", () => {
    expect(isSyncedResource(root)).toBe(false)
    expect(isSyncedResource(repo)).toBe(true)
    expect(isSyncedResource(tasklist)).toBe(true)
    expect(isGithubImportBinding(repo)).toBe(false)
    expect(isGithubImportBinding(importRepo)).toBe(true)
    expect(isGithubImportBinding(tasklist)).toBe(false)
  })
})
