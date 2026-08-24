import {
  DEFAULT_REPO_HOST,
  RepoSpecError,
  parseRepoSpec,
  repoCacheSegments,
  type RemoteRepoSpec,
} from "./repo-spec"

const asRemote = (input: string): RemoteRepoSpec => {
  const spec = parseRepoSpec(input)
  if (spec.kind !== "remote") throw new Error(`expected a remote for ${input}`)
  return spec
}

describe("parseRepoSpec", () => {
  it("reads a bare owner/repo against the default host", () => {
    expect(asRemote("pallets/flask")).toMatchObject({
      host: DEFAULT_REPO_HOST,
      owner: "pallets",
      repo: "flask",
      url: "https://github.com/pallets/flask.git",
    })
  })

  it("reads host/owner/repo", () => {
    expect(asRemote("gitlab.com/group/proj")).toMatchObject({
      host: "gitlab.com",
      owner: "group",
      repo: "proj",
    })
  })

  it.each([
    "https://github.com/pallets/flask",
    "https://github.com/pallets/flask.git",
    "https://GitHub.com/pallets/flask.git",
  ])("normalizes the https form %s", (input) => {
    expect(asRemote(input)).toMatchObject({
      host: "github.com",
      owner: "pallets",
      repo: "flask",
      url: "https://github.com/pallets/flask.git",
    })
  })

  it.each(["git@github.com:pallets/flask.git", "ssh://git@github.com/pallets/flask.git"])(
    "canonicalizes the ssh form %s to https",
    (input) => {
      // The clone guard only accepts https; carrying the ssh spelling forward
      // would fail later with an error about a transport the user never chose.
      expect(asRemote(input).url).toBe("https://github.com/pallets/flask.git")
    }
  )

  it("pins a ref given with #", () => {
    expect(asRemote("pallets/flask#2.3.x").ref).toBe("2.3.x")
    expect(asRemote("https://github.com/o/r.git#abc123").ref).toBe("abc123")
    expect(asRemote("pallets/flask").ref).toBeUndefined()
  })

  it.each(["/abs/path/repo", "./relative", "../up", "~/code/repo", ".", "C:\\code\\repo"])(
    "treats %s as a local path",
    (input) => {
      expect(parseRepoSpec(input)).toEqual({ kind: "local", path: input })
    }
  )

  it("refuses http rather than silently upgrading it", () => {
    // Rewriting the scheme would hide that the remote was never reachable
    // over TLS in the first place.
    expect(() => parseRepoSpec("http://github.com/o/r.git")).toThrow(/only https/)
  })

  it("refuses credentials embedded in the URL", () => {
    expect(() => parseRepoSpec("https://user:pw@github.com/o/r.git")).toThrow(/credentials/)
  })

  it.each([
    ["", /empty/],
    ["   ", /empty/],
    ["--upload-pack=x", /begin with/],
    ["justonesegment", /expected a path/],
    ["a/b/c/d/e", /expected a path/],
    ["https://github.com/onlyowner", /owner>\/<repo/],
  ])("rejects %s", (input, pattern) => {
    expect(() => parseRepoSpec(input)).toThrow(pattern)
  })

  it("rejects segments that are not names", () => {
    expect(() => parseRepoSpec("github.com/../repo")).toThrow(RepoSpecError)
    expect(() => parseRepoSpec("own er/repo")).toThrow(RepoSpecError)
    expect(() => parseRepoSpec("owner/re;po")).toThrow(RepoSpecError)
  })

  it("flattens a nested gitlab path into one repo segment", () => {
    // GitLab subgroups nest; the cache key stays three segments deep so a
    // subgroup cannot introduce a directory level of its own.
    const spec = asRemote("https://gitlab.com/group/sub/proj")
    expect(spec.owner).toBe("group")
    expect(spec.repo).toBe("sub-proj")
    expect(repoCacheSegments(spec)).toEqual(["gitlab.com", "group", "sub-proj"])
  })
})

describe("repoCacheSegments", () => {
  it("is host-first so two owners of the same name stay apart", () => {
    expect(repoCacheSegments(asRemote("pallets/flask"))).toEqual(["github.com", "pallets", "flask"])
    expect(repoCacheSegments(asRemote("gitlab.com/pallets/flask"))).toEqual([
      "gitlab.com",
      "pallets",
      "flask",
    ])
  })
})
