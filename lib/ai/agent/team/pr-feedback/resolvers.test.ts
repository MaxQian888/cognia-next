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
import type { GitRemote, GitStatus } from "@/types/git"
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
function status(branch: string | null): GitStatus {
  return {
    branch,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    changes: [],
    merge: [],
    isRebasing: false,
    isMerging: false,
  }
}

describe("createResolveTeamRepo", () => {
  it("resolves origin repo + current branch", async () => {
    const resolve = createResolveTeamRepo({
      remotes: async () => [remote({})],
      status: async () => status("develop"),
    })
    expect(await resolve("/repo")).toEqual({ fullName: "acme/app", defaultBranch: "develop" })
  })

  it("prefers the origin remote over others", async () => {
    const resolve = createResolveTeamRepo({
      remotes: async () => [
        remote({ name: "upstream", fetchUrl: "https://github.com/other/repo.git" }),
        remote({}),
      ],
      status: async () => status("main"),
    })
    expect((await resolve("/repo"))?.fullName).toBe("acme/app")
  })

  it("defaults the branch to main when status is unavailable", async () => {
    const resolve = createResolveTeamRepo({
      remotes: async () => [remote({})],
      status: async () => {
        throw new Error("no status")
      },
    })
    expect((await resolve("/repo"))?.defaultBranch).toBe("main")
  })

  it("returns null with no remotes or a non-github remote", async () => {
    expect(
      await createResolveTeamRepo({ remotes: async () => [], status: async () => status("m") })(
        "/r"
      )
    ).toBeNull()
    expect(
      await createResolveTeamRepo({
        remotes: async () => [remote({ fetchUrl: "https://gitlab.com/a/b.git", pushUrl: "" })],
        status: async () => status("m"),
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
    const dispatch = jest.fn(async () => ({
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
