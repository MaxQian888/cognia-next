import {
  classifyGhArgs,
  GH_LOCAL_COMMANDS,
  GH_READ_COMMANDS,
  type GhInvocation,
} from "./gh-command"

const words = (line: string) => line.split(/\s+/).filter(Boolean)
const gh = (line: string, env = {}): GhInvocation => classifyGhArgs(words(line), env)

describe("classifyGhArgs: kinds", () => {
  it.each([
    "",
    "--version",
    "pr",
    "pr view 12",
    "pr list --state open",
    "pr diff 12",
    "pr checks",
    "pr checkout 12",
    "issue view 3 --comments",
    "repo view o/r",
    "repo clone o/r",
    "repo deploy-key list",
    "repo deploy-key",
    "release download v1",
    "run watch 99",
    "search issues bug",
    "status",
    "api repos/o/r/pulls",
    "api -X GET repos/o/r",
    "api --method=head repos/o/r",
    "api --paginate repos/o/r/issues",
    "pr create --help",
    "pr merge -h",
  ])("reads: gh %s", (line) => {
    expect(gh(line).kind).toBe("read")
  })

  it.each([
    ["pr create --fill", "pr create"],
    ["pr comment 12 --body hi", "pr comment"],
    ["pr review 12 --approve", "pr review"],
    ["pr edit 12 --title x", "pr edit"],
    ["pr merge 12 --squash", "pr merge"],
    ["pr close 12", "pr close"],
    ["pr reopen 12", "pr reopen"],
    ["pr ready 12", "pr ready"],
    ["issue create --title t --body b", "issue create"],
    ["issue comment 3 -b x", "issue comment"],
    ["issue edit 3 --add-label bug", "issue edit"],
    ["issue close 3", "issue close"],
    ["issue reopen 3", "issue reopen"],
    ["issue transfer 3 o/other", "issue transfer"],
    ["issue delete 3 --yes", "issue delete"],
    ["release create v1 --notes x", "release create"],
    ["release edit v1 --draft=false", "release edit"],
    ["release delete v1", "release delete"],
    ["release upload v1 a.zip", "release upload"],
    ["repo create o/new --public", "repo create"],
    ["repo delete o/r --yes", "repo delete"],
    ["repo edit --visibility public", "repo edit"],
    ["repo fork o/r", "repo fork"],
    ["repo deploy-key add key.pub", "repo deploy-key add"],
    ["label create bug", "label create"],
    ["label edit bug --color f00", "label edit"],
    ["label delete bug", "label delete"],
    ["gist create a.txt", "gist create"],
    ["workflow run ci.yml", "workflow run"],
    ["run rerun 99", "run rerun"],
    ["secret set TOKEN", "secret set"],
    ["copilot suggest x", "copilot"],
    ["pr frobnicate", "pr frobnicate"],
    ["-- pr create", "pr create"],
  ])("writes: gh %s", (line, command) => {
    expect(gh(line)).toMatchObject({ kind: "write", command })
  })

  it.each([
    "auth login",
    "auth token",
    "config set editor vim",
    "alias set co 'pr checkout'",
    "extension install o/gh-x",
  ])("changes the local setup: gh %s", (line) => {
    expect(gh(line).kind).toBe("local")
  })

  it("reads a flag written between the group and its subcommand (cobra allows it)", () => {
    expect(gh("pr -R o/r create --fill")).toMatchObject({
      kind: "write",
      command: "pr create",
      repositories: ["o/r"],
    })
    expect(gh("pr --repo=o/r view 3").kind).toBe("read")
  })

  it("does not take `-h` for help where it is --homepage", () => {
    expect(gh("repo create o/new -h https://x.dev").kind).toBe("write")
    expect(gh("repo create --help").kind).toBe("read")
  })

  it("keeps the tables disjoint", () => {
    for (const command of GH_LOCAL_COMMANDS) expect(GH_READ_COMMANDS.has(command)).toBe(false)
  })
})

describe("classifyGhArgs: gh api", () => {
  it("is a write for a mutating method or a request body", () => {
    expect(gh("api -X POST repos/o/r/issues")).toMatchObject({
      kind: "write",
      command: "api POST",
      repositories: ["o/r"],
    })
    expect(gh("api -XDELETE /repos/o/r/git/refs/tags/v1")).toMatchObject({
      command: "api DELETE",
      repositories: ["o/r"],
    })
    expect(gh("api repos/o/r/issues/7/comments -f body=hi")).toMatchObject({
      kind: "write",
      command: "api POST",
      repositories: ["o/r"],
      thread: "7",
    })
    expect(gh("api repos/o/r/pulls/9/merge --input body.json")).toMatchObject({
      command: "api POST",
      thread: "9",
    })
    // A body on a GET still sends it: gh would make it a query, but it is
    // not a plain read, so it fails closed.
    expect(gh("api -X GET search/issues -f q=x").kind).toBe("write")
  })

  it("leaves the repository to the checkout for {owner}/{repo} and names none for graphql", () => {
    expect(gh("api -X POST repos/{owner}/{repo}/issues")).toMatchObject({
      repositories: [],
      usesLocalRepository: true,
    })
    expect(gh("api graphql -f query=mutation{x}")).toMatchObject({
      kind: "write",
      repositories: [],
      usesLocalRepository: false,
    })
  })

  it("puts the API host in front of the repository", () => {
    expect(gh("api --hostname ghe.corp.io -X POST repos/o/r/issues").repositories).toEqual([
      "ghe.corp.io/o/r",
    ])
    expect(gh("api -X POST repos/o/r/issues", { GH_HOST: "ghe.corp.io" }).repositories).toEqual([
      "ghe.corp.io/o/r",
    ])
  })

  it("does not read an issue comment id as the thread", () => {
    expect(gh("api -X PATCH repos/o/r/issues/comments/123").thread).toBeUndefined()
  })
})

describe("classifyGhArgs: where a write lands", () => {
  it("names the repository from -R, --repo, a URL or GH_REPO", () => {
    expect(gh("pr create -R o/r").repositories).toEqual(["o/r"])
    expect(gh("pr create -Ro/r").repositories).toEqual(["o/r"])
    expect(gh("pr create --repo=ghe.corp.io/o/r").repositories).toEqual(["ghe.corp.io/o/r"])
    expect(gh("pr comment https://github.com/o/r/pull/12 -b x")).toMatchObject({
      repositories: ["https://github.com/o/r"],
      thread: "12",
      usesLocalRepository: false,
    })
    expect(gh("issue create --title t", { GH_REPO: "o/r" })).toMatchObject({
      repositories: ["o/r"],
      usesLocalRepository: false,
    })
    expect(gh("pr create -R o/r", { GH_REPO: "x/y" }).repositories).toEqual(["o/r"])
  })

  it("uses the checkout when a repository-scoped write names none", () => {
    expect(gh("pr create --fill")).toMatchObject({ repositories: [], usesLocalRepository: true })
    expect(gh("release create v1")).toMatchObject({ usesLocalRepository: true })
    expect(gh("repo edit --visibility public")).toMatchObject({ usesLocalRepository: true })
  })

  it("names no repository for writes that are not a repository's", () => {
    for (const line of ["gist create a.txt", "copilot suggest x", "repo create new-name"]) {
      expect(gh(line)).toMatchObject({ repositories: [], usesLocalRepository: false })
    }
    expect(gh("secret set T --org acme")).toMatchObject({ usesLocalRepository: false })
    expect(gh("secret set T --org acme", { GH_REPO: "o/r" }).repositories).toEqual([])
  })

  it("names a gh repo positional", () => {
    expect(gh("repo delete o/r --yes").repositories).toEqual(["o/r"])
    expect(gh("repo create o/new --private").repositories).toEqual(["o/new"])
  })

  it("names the thread only when exactly one is given", () => {
    expect(gh("pr merge 12 --squash").thread).toBe("12")
    expect(gh("issue close #3").thread).toBe("3")
    expect(gh("pr comment 12 --body 34").thread).toBe("12")
    expect(gh("pr comment --body 34").thread).toBeUndefined()
    expect(gh("pr merge my-branch").thread).toBeUndefined()
    expect(gh("issue transfer 3 4").thread).toBeUndefined()
    expect(gh("pr create --fill").thread).toBeUndefined()
  })
})
