import { commitShell } from "./commit-shell"
import type { GitCommit } from "@/types/git"

const commit = (hash: string, summary: string): GitCommit => ({
  hash,
  shortHash: hash.slice(0, 7),
  summary,
  body: "",
  authorName: "A",
  authorEmail: "a@x",
  authoredAtMs: 1,
  parents: [],
})

describe("commitShell", () => {
  it("returns the commit from the first history that holds it", () => {
    const repo = [commit("aaaaaaaa1", "repo copy")]
    const file = [commit("aaaaaaaa1", "file copy"), commit("bbbbbbbb2", "only in file")]
    expect(commitShell("aaaaaaaa1", [repo, file]).summary).toBe("repo copy")
    expect(commitShell("bbbbbbbb2", [repo, file]).summary).toBe("only in file")
  })

  it("falls back to a stub carrying the short hash", () => {
    const shell = commitShell("cccccccccc", [[], []])
    expect(shell).toMatchObject({ hash: "cccccccccc", shortHash: "ccccccc", summary: "" })
  })
})
