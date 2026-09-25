import {
  asGitError,
  commitDiffKey,
  EMPTY_REPO_STATE,
  EMPTY_STATUS,
  fileDiffKey,
  isWorkingDiffKey,
} from "./index"

describe("diff cache keys", () => {
  it("distinguishes staged vs working", () => {
    expect(fileDiffKey("a.ts", false)).toBe("w:a.ts")
    expect(fileDiffKey("a.ts", true)).toBe("s:a.ts")
  })

  it("namespaces commit diffs by sha + path", () => {
    expect(commitDiffKey("abc", "a.ts")).toBe("c:abc:a.ts")
  })

  it("tells working and staged keys apart from immutable commit keys", () => {
    expect(isWorkingDiffKey(fileDiffKey("a.ts", false))).toBe(true)
    expect(isWorkingDiffKey(fileDiffKey("a.ts", true))).toBe(true)
    expect(isWorkingDiffKey(commitDiffKey("abc", "a.ts"))).toBe(false)
  })
})

describe("asGitError", () => {
  it("narrows a tagged error payload", () => {
    expect(asGitError({ kind: "authRequired", detail: "nope" })).toEqual({
      kind: "authRequired",
      detail: "nope",
    })
  })

  it("returns null for non-git errors", () => {
    expect(asGitError(new Error("boom"))).toBeNull()
    expect(asGitError("string")).toBeNull()
    expect(asGitError(null)).toBeNull()
    expect(asGitError({ message: "x" })).toBeNull()
  })
})

describe("inert constants", () => {
  it("are frozen and empty", () => {
    expect(EMPTY_STATUS.staged).toEqual([])
    expect(EMPTY_REPO_STATE.isRepo).toBe(false)
    expect(Object.isFrozen(EMPTY_STATUS)).toBe(true)
  })
})
