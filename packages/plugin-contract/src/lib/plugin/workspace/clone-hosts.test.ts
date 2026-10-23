import { DEFAULT_WORKSPACE_CLONE_HOSTS, validateWorkspaceCloneHosts } from "./clone-hosts"

describe("validateWorkspaceCloneHosts", () => {
  it("defaults to no extra hosts and returns a detached list", () => {
    expect(validateWorkspaceCloneHosts(undefined)).toEqual([])
    expect(validateWorkspaceCloneHosts([])).toEqual([])
    const hosts = ["git.corp.example", "git-server.internal", "git"]
    expect(validateWorkspaceCloneHosts(hosts)).toEqual(hosts)
    expect(validateWorkspaceCloneHosts(hosts)).not.toBe(hosts)
  })

  it("keeps the native default host floor explicit", () => {
    expect(DEFAULT_WORKSPACE_CLONE_HOSTS).toEqual(["github.com", "gitlab.com", "bitbucket.org"])
  })

  it.each([
    null,
    "git.corp.example",
    {},
    [null],
    [42],
    [""],
    ["Git.Corp.Example"],
    ["https://git.corp.example"],
    ["git.corp.example/repo"],
    ["git.corp.example:443"],
    ["*.corp.example"],
    ["user@git.corp.example"],
    ["git.corp.example?token=x"],
    ["git.corp.example#fragment"],
    [" git.corp.example"],
    ["git.corp.example "],
    ["git..corp.example"],
    ["git.corp.example."],
    ["-git.corp.example"],
    ["git-.corp.example"],
    ["git_server.corp.example"],
    ["gít.corp.example"],
    ["127.0.0.1"],
    ["127.1"],
    ["2130706433"],
    ["0x7f000001"],
    ["0177.0.0.1"],
    ["[::1]"],
    ["::1"],
    ["git.corp.example", "git.corp.example"],
    [`${"a".repeat(64)}.example`],
    [`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`],
  ])("rejects unsafe or malformed host declarations %p", (value) => {
    expect(() => validateWorkspaceCloneHosts(value)).toThrow("workspaceCloneHosts")
  })
})
