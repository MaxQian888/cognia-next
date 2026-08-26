import { parseForgeRemote } from "./remote"

describe("parseForgeRemote", () => {
  it.each([
    ["https://github.com/acme/app.git", "acme/app"],
    ["https://github.com/acme/app", "acme/app"],
    ["https://github.com/acme/app/", "acme/app"],
    ["git@github.com:acme/app.git", "acme/app"],
    ["ssh://git@github.com/acme/app.git", "acme/app"],
    ["https://WWW.GitHub.com/acme/app", "acme/app"],
  ])("reads %s as a GitHub repository", (url, fullName) => {
    expect(parseForgeRemote(url)).toEqual({ forge: "github", fullName })
  })

  it("names the host it cannot serve rather than pretending there is no remote", () => {
    // The panel says two different things here: "add a remote" versus "this
    // host has no adapter". Collapsing them sends people to fix the wrong end.
    expect(parseForgeRemote("https://gitlab.com/acme/app.git")).toEqual({
      forge: "unsupported",
      host: "gitlab.com",
    })
    expect(parseForgeRemote("git@gitea.internal:acme/app.git")).toEqual({
      forge: "unsupported",
      host: "gitea.internal",
    })
  })

  it("does not treat GitHub Enterprise as github.com", () => {
    // A compatible API is not the same host: it has no stacks endpoint, and a
    // token minted for github.com must never be sent there.
    expect(parseForgeRemote("https://github.acme.com/acme/app")).toEqual({
      forge: "unsupported",
      host: "github.acme.com",
    })
  })

  it("returns null for remotes that are not a host at all", () => {
    expect(parseForgeRemote("")).toBeNull()
    expect(parseForgeRemote("   ")).toBeNull()
    expect(parseForgeRemote("file:///srv/repo.git")).toBeNull()
    expect(parseForgeRemote("/srv/repo")).toBeNull()
    expect(parseForgeRemote("../sibling-repo")).toBeNull()
  })

  it("keeps an ssh URL's path intact instead of rewriting its scheme", () => {
    // `ssh://host/path` contains a colon too; a scp-syntax rewrite that does
    // not exclude it produces `ssh://ssh:/…` and loses the repository.
    expect(parseForgeRemote("ssh://github.com/acme/app")).toEqual({
      forge: "github",
      fullName: "acme/app",
    })
  })

  it("takes the last two path segments, so a subgroup URL still names a repository", () => {
    expect(parseForgeRemote("https://gitlab.com/group/sub/app.git")).toEqual({
      forge: "unsupported",
      host: "gitlab.com",
    })
  })

  it("reports a host with no repository path as unsupported rather than parsing garbage", () => {
    expect(parseForgeRemote("https://github.com/acme")).toEqual({
      forge: "unsupported",
      host: "github.com",
    })
  })
})
