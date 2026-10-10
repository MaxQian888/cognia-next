import type { GitDefaultBranch, GitRemote, GitStatus } from "@/types/git"

import {
  httpsRemoteUrl,
  isValidBranchName,
  remoteWorkspaceSource,
  workBranchFor,
  type RemoteWorkspaceGit,
} from "./remote-workspace"

function status(upstream: string | null): GitStatus {
  return {
    branch: "feature",
    upstream,
    ahead: 0,
    behind: 0,
    staged: [],
    changes: [],
    merge: [],
    isRebasing: false,
    isMerging: false,
  }
}

function git(
  remotes: GitRemote[],
  upstream: string | null,
  fallback: GitDefaultBranch = { branch: "main", source: "remoteHead", exists: true }
): RemoteWorkspaceGit {
  return {
    remotes: async () => remotes,
    status: async () => status(upstream),
    defaultBranch: async () => fallback,
  }
}

const origin = (url: string): GitRemote => ({ name: "origin", fetchUrl: url, pushUrl: url })

describe("httpsRemoteUrl", () => {
  it.each([
    ["https://github.com/acme/app.git", "https://github.com/acme/app.git"],
    ["https://token@github.com/acme/app.git/", "https://github.com/acme/app.git"],
    ["git@github.com:acme/app.git", "https://github.com/acme/app.git"],
    ["ssh://git@gitlab.example.com:2222/group/app", "https://gitlab.example.com/group/app"],
    ["https://git.example.com:8443/app", "https://git.example.com:8443/app"],
  ])("%s → %s", (input, expected) => {
    expect(httpsRemoteUrl(input)).toBe(expected)
  })

  it.each([
    "http://github.com/acme/app",
    "/srv/repos/app",
    "file:///srv/app",
    "https://github.com",
    "",
  ])("refuses %s", (input) => {
    expect(httpsRemoteUrl(input)).toBeUndefined()
  })
})

describe("work branches", () => {
  it("are valid branch names derived from the agent id", () => {
    expect(workBranchFor("ACP Session:42")).toBe("cognia/acp-session-42")
    expect(workBranchFor("***")).toBe("cognia/agent")
    expect(isValidBranchName(workBranchFor("x".repeat(500)))).toBe(true)
  })

  it("mirror the Host's branch grammar", () => {
    for (const valid of ["main", "feature/x", "release-1.2"])
      expect(isValidBranchName(valid)).toBe(true)
    for (const invalid of [
      "",
      "HEAD",
      "-x",
      "a..b",
      "a b",
      "a.lock",
      "x/.y",
      "a/",
      "a~1",
      "a".repeat(201),
    ])
      expect(isValidBranchName(invalid)).toBe(false)
  })
})

describe("remoteWorkspaceSource", () => {
  it("clones the branch the checkout tracks and works on the agent's own", async () => {
    await expect(
      remoteWorkspaceSource(
        { root: "/repo", agentId: "agent-1" },
        git([origin("git@github.com:acme/app.git")], "origin/feature/login")
      )
    ).resolves.toEqual({
      ok: true,
      source: {
        remoteUrl: "https://github.com/acme/app.git",
        baseRef: "feature/login",
        branch: "cognia/agent-1",
      },
    })
  })

  it("falls back to the remote's default branch when nothing is tracked there", async () => {
    await expect(
      remoteWorkspaceSource(
        { root: "/repo", agentId: "a" },
        git([origin("https://github.com/acme/app.git")], "fork/feature")
      )
    ).resolves.toMatchObject({ ok: true, source: { baseRef: "main" } })
  })

  it.each([
    ["no_checkout", { root: "", agentId: "a" }, git([], null)],
    ["no_remote", { root: "/repo", agentId: "a" }, git([], null)],
    ["remote_not_https", { root: "/repo", agentId: "a" }, git([origin("/srv/app")], null)],
    [
      "no_base_branch",
      { root: "/repo", agentId: "a" },
      git([origin("https://github.com/acme/app.git")], null, {
        branch: "main",
        source: "localBranch",
        exists: true,
      }),
    ],
  ] as const)("refuses %s", async (reason, request, deps) => {
    await expect(remoteWorkspaceSource(request, deps)).resolves.toEqual({
      ok: false,
      code: "sandbox_workspace_remote_required",
      detail: { reason },
    })
  })
})
