jest.mock("@/lib/terminal/headless-exec", () => ({ runHeadlessExec: jest.fn() }))

import {
  createResolveOctokit,
  createResolveTeamRepo,
  createRunPrReview,
  ghCliToken,
  parseGitHubRepo,
} from "./resolvers"
import { runHeadlessExec } from "@/lib/terminal/headless-exec"

const mockExec = runHeadlessExec as jest.Mock
import type { GitDefaultBranch, GitRemote } from "@/types/git"
import type { TeammatePrBinding } from "./binding"
import type { PrObservation } from "@/lib/github/pr-observe/types"

describe("parseGitHubRepo", () => {
  it.each([
    ["https://github.com/acme/app.git", "acme/app"],
    ["https://github.com/acme/app", "acme/app"],
    ["git@github.com:acme/app.git", "acme/app"],
    ["ssh://git@github.com/acme/app.git", "acme/app"],
  ])("parses %s", (url, expected) => {
    expect(parseGitHubRepo(url)).toBe(expected)
  })

  it("returns null for non-github or empty urls", () => {
    expect(parseGitHubRepo("https://gitlab.com/a/b")).toBeNull()
    expect(parseGitHubRepo("")).toBeNull()
  })
})

function remote(over: Partial<GitRemote>): GitRemote {
  return { name: "origin", fetchUrl: "https://github.com/acme/app.git", pushUrl: "", ...over }
}
function trunk(over: Partial<GitDefaultBranch> = {}): GitDefaultBranch {
  return { branch: "main", source: "remoteHead", exists: true, ...over }
}

describe("createResolveTeamRepo", () => {
  it("resolves the origin repo and the repository's trunk", async () => {
    const resolve = createResolveTeamRepo({
      remotes: async () => [remote({})],
      defaultBranch: async () => trunk({ branch: "develop" }),
    })
    expect(await resolve("/repo")).toEqual({
      fullName: "acme/app",
      defaultBranch: "develop",
      defaultBranchSource: "remoteHead",
      defaultBranchExists: true,
    })
  })

  it("reports the trunk, not whatever branch is checked out", async () => {
    // The regression this replaced: the resolver read `git status().branch`,
    // so an agent working on a feature branch reported that feature branch as
    // the repository default — and the stack publisher rooted the whole stack
    // on it. The seam is now a dedicated trunk read that never sees HEAD.
    const seen: Array<[string, string | undefined]> = []
    const resolve = createResolveTeamRepo({
      remotes: async () => [remote({})],
      defaultBranch: async (dir, name) => {
        seen.push([dir, name])
        return trunk({ branch: "main", source: "remoteBranch" })
      },
    })
    expect((await resolve("/repo"))?.defaultBranch).toBe("main")
    expect(seen).toEqual([["/repo", "origin"]])
  })

  it("asks about the remote it actually picked", async () => {
    const seen: Array<string | undefined> = []
    const resolve = createResolveTeamRepo({
      remotes: async () => [remote({ name: "upstream" })],
      defaultBranch: async (_dir, name) => {
        seen.push(name)
        return trunk()
      },
    })
    await resolve("/repo")
    expect(seen).toEqual(["upstream"])
  })

  it("prefers the origin remote over others", async () => {
    const resolve = createResolveTeamRepo({
      remotes: async () => [
        remote({ name: "upstream", fetchUrl: "https://github.com/other/repo.git" }),
        remote({}),
      ],
      defaultBranch: async () => trunk(),
    })
    expect((await resolve("/repo"))?.fullName).toBe("acme/app")
  })

  it("degrades to an honest guess when the trunk read fails", async () => {
    const resolve = createResolveTeamRepo({
      remotes: async () => [remote({})],
      defaultBranch: async () => {
        throw new Error("no git bridge")
      },
    })
    const resolved = await resolve("/repo")
    expect(resolved?.defaultBranch).toBe("main")
    // Carried through so a caller can refuse rather than publish onto it.
    expect(resolved?.defaultBranchSource).toBe("guess")
    expect(resolved?.defaultBranchExists).toBe(false)
  })

  it("returns null with no remotes or a non-github remote", async () => {
    expect(
      await createResolveTeamRepo({
        remotes: async () => [],
        defaultBranch: async () => trunk(),
      })("/r")
    ).toBeNull()
    expect(
      await createResolveTeamRepo({
        remotes: async () => [remote({ fetchUrl: "https://gitlab.com/a/b.git", pushUrl: "" })],
        defaultBranch: async () => trunk(),
      })("/r")
    ).toBeNull()
  })
})

describe("ghCliToken", () => {
  beforeEach(() => mockExec.mockReset())

  it("extracts a gh token from PTY output (ignoring the echoed command)", async () => {
    mockExec.mockResolvedValue({
      ok: true,
      exitCode: 0,
      output: "gh auth token\r\nghp_abc123XYZ\r\n",
    })
    expect(await ghCliToken()).toBe("ghp_abc123XYZ")
  })

  it("extracts a github_pat token", async () => {
    mockExec.mockResolvedValue({ ok: true, exitCode: 0, output: "github_pat_11ABCDEF_xyz" })
    expect(await ghCliToken()).toBe("github_pat_11ABCDEF_xyz")
  })

  it("returns null on a non-zero exit code", async () => {
    mockExec.mockResolvedValue({ ok: true, exitCode: 1, output: "not logged in" })
    expect(await ghCliToken()).toBeNull()
  })

  it("returns null when no token-shaped line is present", async () => {
    mockExec.mockResolvedValue({ ok: true, exitCode: 0, output: "error: gh not configured" })
    expect(await ghCliToken()).toBeNull()
  })

  it("returns null when the command failed", async () => {
    mockExec.mockResolvedValue({ ok: false, reason: "blocked" })
    expect(await ghCliToken()).toBeNull()
  })

  it("returns null when exec throws", async () => {
    mockExec.mockRejectedValue(new Error("no terminal"))
    expect(await ghCliToken()).toBeNull()
  })
})

describe("createResolveOctokit", () => {
  it("returns null when no token is available", async () => {
    const build = jest.fn()
    const resolve = createResolveOctokit({ getToken: async () => null, build })
    expect(await resolve("acme/app")).toBeNull()
    expect(build).not.toHaveBeenCalled()
  })

  it("builds a PAT octokit when a token is available", async () => {
    const octo = { request: jest.fn() }
    const build = jest.fn(async () => octo)
    const resolve = createResolveOctokit({ getToken: async () => "ghp_token", build })
    expect(await resolve("acme/app")).toBe(octo)
    expect(build).toHaveBeenCalledWith({
      repoFullName: "acme/app",
      mode: "pat",
      pat: { token: "ghp_token" },
    })
  })

  it("returns null when the build throws", async () => {
    const resolve = createResolveOctokit({
      getToken: async () => "ghp_token",
      build: async () => {
        throw new Error("bad token")
      },
    })
    expect(await resolve("acme/app")).toBeNull()
  })
})

const binding: TeammatePrBinding = {
  runId: "run-1",
  teamId: "team-a",
  memberId: "m1",
  taskId: "t1",
  repo: "acme/app",
  branch: "b",
}

function obs(): PrObservation {
  return {
    fetched: true,
    observedAt: 1,
    repo: "acme/app",
    pr: {
      url: "u",
      number: 5,
      state: "open",
      draft: false,
      merged: false,
      closed: false,
      sourceBranch: "b",
      targetBranch: "main",
      headSha: "s",
      title: "t",
      additions: 0,
      deletions: 0,
      author: "d",
    },
    ci: { summary: "passing", headSha: "s", failedChecks: [] },
    review: { decision: "none", threads: [] },
    mergeability: { state: "mergeable", mergeable: true, conflict: false, behindBase: false },
    changed: { metadata: true, ci: true, review: true },
  }
}

describe("createRunPrReview", () => {
  it("returns null when the run context is gone", async () => {
    const run = createRunPrReview({ getCtx: () => undefined, dispatch: jest.fn() as never })
    expect(await run(binding, obs())).toBeNull()
  })

  it("dispatches a structured review and returns the verdict", async () => {
    const dispatch = jest.fn(async () => ({
      value: { verdict: "changes_requested", body: "fix" },
      teammateId: "x",
      raw: "{}",
      schemaOverridden: false,
    }))
    const run = createRunPrReview({ getCtx: () => ({}) as never, dispatch: dispatch as never })
    expect(await run(binding, obs())).toEqual({ verdict: "changes_requested", body: "fix" })
    expect(dispatch).toHaveBeenCalled()
  })

  it("returns null when dispatch throws", async () => {
    const dispatch = jest.fn(async () => {
      throw new Error("dispatch failed")
    })
    const run = createRunPrReview({ getCtx: () => ({}) as never, dispatch: dispatch as never })
    expect(await run(binding, obs())).toBeNull()
  })

  it("PII-gates the reviewer prompt (user-derived PR title) before dispatch", async () => {
    const dispatch = jest.fn(async (_ctx: unknown, _opts: { prompt: string }) => ({
      value: { verdict: "approved", body: "ok" },
      teammateId: "x",
      raw: "{}",
      schemaOverridden: false,
    }))
    const run = createRunPrReview({ getCtx: () => ({}) as never, dispatch: dispatch as never })
    const leaky = obs()
    leaky.pr = { ...leaky.pr, title: "fix login for alice@example.com" }
    await run(binding, leaky)
    const sentPrompt = (dispatch.mock.calls[0]![1] as { prompt: string }).prompt
    // The raw email must not leak to the model; the prompt structure survives.
    expect(sentPrompt).not.toContain("alice@example.com")
    expect(sentPrompt).toContain("Review pull request #5")
  })
})
