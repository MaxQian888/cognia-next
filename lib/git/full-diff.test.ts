import type { GitDiff, GitHunk } from "@/types/git"
import { parseUnifiedPatch } from "./unified-patch"
import { StaleHunksError, applyHunks, loadFullGitDiff } from "./full-diff"

/** Hunks the way libgit2 reports them, built from patch text. */
function hunksOf(patch: string): GitHunk[] {
  return parseUnifiedPatch(patch)[0].hunks
}

const OLD = "a\nb\nc\nd\ne\nf\ng\nh\n"
const NEW = "a\nB\nc\nd\ne\nf\ng\nh\ni\n"
const HUNKS = hunksOf(
  [
    "--- a/x",
    "+++ b/x",
    "@@ -1,3 +1,3 @@",
    " a",
    "-b",
    "+B",
    " c",
    "@@ -6,3 +6,4 @@",
    " f",
    " g",
    " h",
    "+i",
  ].join("\n")
)

describe("applyHunks", () => {
  it("turns the old side into the new one and back", () => {
    expect(applyHunks(OLD, HUNKS, "forward")).toBe(NEW)
    expect(applyHunks(NEW, HUNKS, "reverse")).toBe(OLD)
  })

  it("handles a created file and a deleted one", () => {
    const create = hunksOf(["--- /dev/null", "+++ b/n", "@@ -0,0 +1,2 @@", "+x", "+y"].join("\n"))
    expect(applyHunks("", create, "forward")).toBe("x\ny\n")
    expect(applyHunks("x\ny\n", create, "reverse")).toBe("")
  })

  it("keeps a missing final newline exact", () => {
    const hunks = hunksOf(
      ["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+a"].join("\n")
    )
    expect(applyHunks("a", hunks, "forward")).toBe("a\n")
    expect(applyHunks("a\n", hunks, "reverse")).toBe("a")
  })

  it("keeps CRLF line ends as they are", () => {
    const hunks: GitHunk[] = [
      {
        header: "@@ -1,2 +1,2 @@",
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        patch: "",
        lines: [
          { kind: "context", content: "a\r\n" },
          { kind: "del", content: "b\r\n" },
          { kind: "add", content: "B\r\n" },
        ],
      },
    ]
    expect(applyHunks("a\r\nb\r\n", hunks, "forward")).toBe("a\r\nB\r\n")
  })

  it("reports a file that moved on since the hunks were read", () => {
    expect(() => applyHunks("a\nX\nc\n", HUNKS, "forward")).toThrow(StaleHunksError)
    expect(() => applyHunks("a\n", HUNKS, "forward")).toThrow(StaleHunksError)
  })
})

describe("loadFullGitDiff", () => {
  const omitted: GitDiff = {
    path: "x",
    oldContent: "",
    newContent: "",
    hunks: HUNKS,
    isBinary: false,
    contentOmitted: true,
  }

  it("reads the working file and rebuilds the index side for an unstaged diff", async () => {
    const readHeadBlob = jest.fn()
    const full = await loadFullGitDiff(omitted, false, {
      readWorkingFile: async () => NEW,
      readHeadBlob,
    })
    expect(full).toMatchObject({ oldContent: OLD, newContent: NEW, contentOmitted: false })
    expect(readHeadBlob).not.toHaveBeenCalled()
  })

  it("reads HEAD and rebuilds the index side for a staged diff", async () => {
    const full = await loadFullGitDiff(omitted, true, {
      readWorkingFile: jest.fn(),
      readHeadBlob: async () => OLD,
    })
    expect(full).toMatchObject({ oldContent: OLD, newContent: NEW })
  })

  it("does not read a side that does not exist", async () => {
    const deletion = hunksOf(["--- a/x", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-p", "-q"].join("\n"))
    const readWorkingFile = jest.fn()
    const full = await loadFullGitDiff({ ...omitted, hunks: deletion }, false, {
      readWorkingFile,
      readHeadBlob: jest.fn(),
    })
    expect(readWorkingFile).not.toHaveBeenCalled()
    expect(full).toMatchObject({ oldContent: "p\nq\n", newContent: "" })

    const creation = hunksOf(["--- /dev/null", "+++ b/x", "@@ -0,0 +1 @@", "+z"].join("\n"))
    const readHeadBlob = jest.fn()
    const staged = await loadFullGitDiff({ ...omitted, hunks: creation }, true, {
      readWorkingFile: jest.fn(),
      readHeadBlob,
    })
    expect(readHeadBlob).not.toHaveBeenCalled()
    expect(staged).toMatchObject({ oldContent: "", newContent: "z\n" })
  })

  it("rejects as stale when the file changed after the hunks were read", async () => {
    await expect(
      loadFullGitDiff(omitted, false, {
        readWorkingFile: async () => "something else\n",
        readHeadBlob: jest.fn(),
      })
    ).rejects.toBeInstanceOf(StaleHunksError)
  })
})
