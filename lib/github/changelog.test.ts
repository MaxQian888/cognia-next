import {
  applyBump,
  computeBump,
  parseCommitMessage,
  renderChangelog,
  type ParsedCommit,
} from "./changelog"

describe("parseCommitMessage", () => {
  it("parses feat with subject only", () => {
    const c = parseCommitMessage("h", "feat: add login button")
    expect(c).toMatchObject({ type: "feat", subject: "add login button", breaking: false })
  })

  it("parses fix with scope", () => {
    const c = parseCommitMessage("h", "fix(auth): handle null user")
    expect(c).toMatchObject({ type: "fix", scope: "auth", breaking: false })
  })

  it("flags breaking with bang", () => {
    const c = parseCommitMessage("h", "feat!: change API surface")
    expect(c?.breaking).toBe(true)
  })

  it("flags breaking with footer", () => {
    const c = parseCommitMessage("h", "refactor: rewire context\n\nBREAKING CHANGE: ctx.db is gone")
    expect(c?.breaking).toBe(true)
  })

  it("returns null on non-conventional commit", () => {
    expect(parseCommitMessage("h", "WIP changes")).toBeNull()
  })

  it("attaches author meta when supplied", () => {
    const c = parseCommitMessage("h", "fix: x", { authorName: "Alice", authorEmail: "a@x.com" })
    expect(c?.authorName).toBe("Alice")
  })

  it("lower-cases the type", () => {
    const c = parseCommitMessage("h", "FEAT: shouty")
    expect(c?.type).toBe("feat")
  })

  it("ignores non-BREAKING text in body when no footer prefix", () => {
    const c = parseCommitMessage("h", "feat: x\n\nthis is breaking news, big change")
    expect(c?.breaking).toBe(false)
  })
})

describe("computeBump", () => {
  const c = (type: string, breaking = false): ParsedCommit => ({
    hash: "x",
    type,
    breaking,
    subject: "y",
  })

  it("returns 'none' for empty input", () => {
    expect(computeBump([])).toBe("none")
  })

  it("returns 'none' for chore-only commits", () => {
    expect(computeBump([c("chore"), c("docs")])).toBe("none")
  })

  it("fix-only → patch", () => {
    expect(computeBump([c("fix"), c("chore")])).toBe("patch")
  })

  it("feat → minor (overrides patch)", () => {
    expect(computeBump([c("fix"), c("feat")])).toBe("minor")
  })

  it("breaking → major (overrides everything, even when first)", () => {
    expect(computeBump([c("fix", true), c("feat")])).toBe("major")
  })

  it("breaking late in list still wins", () => {
    expect(computeBump([c("feat"), c("chore", true)])).toBe("major")
  })
})

describe("applyBump", () => {
  it("major bump zeroes minor and patch", () => {
    expect(applyBump("1.2.3", "major")).toBe("2.0.0")
  })

  it("minor bump zeroes patch", () => {
    expect(applyBump("1.2.3", "minor")).toBe("1.3.0")
  })

  it("patch bump increments patch", () => {
    expect(applyBump("1.2.3", "patch")).toBe("1.2.4")
  })

  it("none returns the cleaned current version", () => {
    expect(applyBump("v1.2.3", "none")).toBe("1.2.3")
  })

  it("strips leading v and pre-release / build metadata", () => {
    expect(applyBump("v1.2.3-beta.1+build.99", "patch")).toBe("1.2.4")
  })

  it("treats malformed segments as 0", () => {
    expect(applyBump("v1", "patch")).toBe("1.0.1")
  })
})

describe("renderChangelog", () => {
  const FEAT: ParsedCommit = { hash: "abc1234", type: "feat", subject: "add x", breaking: false }
  const FIX: ParsedCommit = {
    hash: "def5678",
    type: "fix",
    subject: "patch y",
    breaking: false,
    scope: "auth",
  }
  const BREAKING: ParsedCommit = {
    hash: "0011223",
    type: "feat",
    subject: "rewire",
    breaking: true,
  }

  it("renders the version header and bump label", () => {
    const md = renderChangelog([FEAT], { bump: "minor", nextVersion: "1.3.0", repoFullName: null })
    expect(md).toMatch(/## 1\.3\.0/)
    expect(md).toMatch(/_Bump: minor_/)
  })

  it("groups by category in canonical order", () => {
    const md = renderChangelog([FIX, FEAT], {
      bump: "minor",
      nextVersion: "1.3.0",
      repoFullName: null,
    })
    expect(md.indexOf("Features")).toBeLessThan(md.indexOf("Bug Fixes"))
  })

  it("emits scope as bold prefix", () => {
    const md = renderChangelog([FIX], { bump: "patch", nextVersion: "1.2.4", repoFullName: null })
    expect(md).toMatch(/\*\*auth\*\*:/)
  })

  it("hyperlinks short hash when repoFullName is provided", () => {
    const md = renderChangelog([FEAT], {
      bump: "minor",
      nextVersion: "1.3.0",
      repoFullName: "octocat/hello-world",
    })
    expect(md).toMatch(
      /\[abc1234\]\(https:\/\/github\.com\/octocat\/hello-world\/commit\/abc1234\)/
    )
  })

  it("emits a BREAKING CHANGES section when any commit is breaking", () => {
    const md = renderChangelog([BREAKING], {
      bump: "major",
      nextVersion: "2.0.0",
      repoFullName: null,
    })
    expect(md).toMatch(/⚠ BREAKING CHANGES/)
  })

  it("emits 'Other Changes' for unknown types", () => {
    const oddball: ParsedCommit = { hash: "x", type: "wip", subject: "stuff", breaking: false }
    const md = renderChangelog([oddball], {
      bump: "none",
      nextVersion: "1.2.3",
      repoFullName: null,
    })
    expect(md).toMatch(/Other Changes/)
  })
})
