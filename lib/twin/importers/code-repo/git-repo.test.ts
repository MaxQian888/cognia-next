jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

// `isTauri` flips per test via mockReturnValue so we can exercise both the
// non-Tauri short-circuit and the happy path.
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { invoke } = require("@tauri-apps/api/core") as { invoke: jest.Mock }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tauriMod = require("@/lib/tauri") as { isTauri: jest.Mock }

import { parseGitRepo, type CommitRecord } from "./git-repo"

const fixtureRecord = (overrides: Partial<CommitRecord> = {}): CommitRecord => ({
  hash: "deadbeefcafe1234567890abcdefabcdefabcdef",
  subject: "feat: initial commit",
  body: "details",
  author: "Alice",
  email: "alice@example.com",
  timestampMs: 1_700_000_000_000,
  filesChanged: 2,
  insertions: 10,
  deletions: 1,
  diff: " path | 5 +++\n 1 file changed, 5 insertions(+)\n\ndiff --git a/path b/path\n+added\n",
  ...overrides,
})

beforeEach(() => {
  invoke.mockReset()
  tauriMod.isTauri.mockReset()
})

describe("parseGitRepo", () => {
  it("returns an empty array when not running inside Tauri", async () => {
    tauriMod.isTauri.mockReturnValue(false)
    const result = await parseGitRepo({ twinId: "tw1", repoPath: "/tmp/repo" })
    expect(result).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })

  it("invokes twin_parse_git_repo with the defaulted args", async () => {
    tauriMod.isTauri.mockReturnValue(true)
    invoke.mockResolvedValue([])

    await parseGitRepo({ twinId: "tw1", repoPath: "/tmp/repo" })

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith("twin_parse_git_repo", {
      args: { repoPath: "/tmp/repo", maxCommits: 200, author: undefined },
    })
  })

  it("forwards a positive maxCommits and trimmed author", async () => {
    tauriMod.isTauri.mockReturnValue(true)
    invoke.mockResolvedValue([])

    await parseGitRepo({
      twinId: "tw1",
      repoPath: "/tmp/repo",
      maxCommits: 50,
      author: "  alice  ",
    })

    expect(invoke).toHaveBeenCalledWith("twin_parse_git_repo", {
      args: { repoPath: "/tmp/repo", maxCommits: 50, author: "alice" },
    })
  })

  it("falls back to the default cap when maxCommits is non-positive", async () => {
    tauriMod.isTauri.mockReturnValue(true)
    invoke.mockResolvedValue([])

    await parseGitRepo({ twinId: "tw1", repoPath: "/tmp/repo", maxCommits: 0 })

    expect(invoke).toHaveBeenCalledWith("twin_parse_git_repo", {
      args: { repoPath: "/tmp/repo", maxCommits: 200, author: undefined },
    })
  })

  it("treats a whitespace-only author as no filter", async () => {
    tauriMod.isTauri.mockReturnValue(true)
    invoke.mockResolvedValue([])

    await parseGitRepo({
      twinId: "tw1",
      repoPath: "/tmp/repo",
      author: "   ",
    })

    expect(invoke).toHaveBeenCalledWith("twin_parse_git_repo", {
      args: { repoPath: "/tmp/repo", maxCommits: 200, author: undefined },
    })
  })

  it("maps Rust records into RawSource shape with stable ids and metadata", async () => {
    tauriMod.isTauri.mockReturnValue(true)
    const record = fixtureRecord()
    invoke.mockResolvedValue([record])

    const [source] = await parseGitRepo({ twinId: "tw1", repoPath: "/repos/proj" })

    expect(source.id).toBe("tws_git_tw1_deadbeefcafe")
    expect(source.filename).toBe("/repos/proj/deadbeefcafe.md")
    expect(source.format).toBe("code")
    expect(source.baseMetadata).toEqual({
      commitSha: record.hash,
      timestamp: record.timestampMs,
      speakers: ["Alice <alice@example.com>"],
    })
    expect(source.text).toContain("# feat: initial commit")
    expect(source.text).toContain(`**Commit:** ${record.hash}`)
    expect(source.text).toContain("**Author:** Alice <alice@example.com>")
    expect(source.text).toContain("**Date:** 2023-11-14T22:13:20.000Z")
    expect(source.text).toContain("```diff")
    expect(source.text).toContain(record.diff)
  })

  it("uses (no body) and skips the Date line when fields are missing", async () => {
    tauriMod.isTauri.mockReturnValue(true)
    invoke.mockResolvedValue([fixtureRecord({ body: "", timestampMs: 0 })])

    const [source] = await parseGitRepo({ twinId: "tw1", repoPath: "/repos/proj" })

    expect(source.text).toContain("(no body)")
    expect(source.text).not.toContain("**Date:**")
  })

  it("returns an empty array when the Rust command rejects", async () => {
    tauriMod.isTauri.mockReturnValue(true)
    invoke.mockRejectedValue("open repository at /bad: …")

    const result = await parseGitRepo({ twinId: "tw1", repoPath: "/bad" })
    expect(result).toEqual([])
  })
})
