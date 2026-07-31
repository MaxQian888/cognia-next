/**
 * @jest-environment jsdom
 *
 * Unit tests for `buildRunPrFeedback` — the resolve→build seam of the Agent
 * Team PR feedback loop, extracted from `runTeamLifecycle` so it is testable
 * without booting a full lifecycle / Dexie. The pr-feedback runtime + git module
 * loaders are injected, so this exercises the wiring (fail-closed guards, the
 * git-push seam, reviewer wiring, and the best-effort error path) directly.
 */
import "fake-indexeddb/auto"

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: jest.fn(() => ({})),
  getPluginLifecycleHooks: jest.fn(() => ({})),
}))
jest.mock("@/lib/ai/agent/agent-executor", () => ({ executeAgent: jest.fn() }))
jest.mock("./team/twin-context", () => ({
  resolveTeamTwinRuntime: jest.fn(async () => ({ availableTwins: [] })),
  applyTeammateTwinContext: jest.fn(),
  searchTwinKnowledge: jest.fn(),
  gatherTeamTwins: jest.fn(),
}))

import { buildRunPrFeedback } from "./agent-team-runtime"
import type { BuildTeamPrFeedbackParams, TeamPrFeedback } from "./team/pr-feedback/runtime"
import type { OctokitLike } from "@/lib/github/pr-observe/types"

type Opts = Parameters<typeof buildRunPrFeedback>[0]

const controller = {
  trackAll: jest.fn(async () => {}),
  settle: jest.fn(async () => {}),
  dispose: jest.fn(),
} as unknown as TeamPrFeedback

function harness(overrides: Partial<Opts> = {}) {
  const buildTeamPrFeedback = jest.fn((_params: BuildTeamPrFeedbackParams) => controller)
  const gitPush = jest.fn(async () => {})
  const opts: Opts = {
    runId: "run-1",
    teamId: "team-1",
    config: { enabled: true },
    workingDir: "/repo",
    teammates: [{ id: "w1", name: "Worker" }],
    tasks: [{ id: "t1", title: "Task 1" }],
    resolveTeamRepo: jest.fn(async () => ({ fullName: "acme/app", defaultBranch: "main" })),
    resolvePrObserveOctokit: jest.fn(async () => ({}) as unknown as OctokitLike),
    notify: jest.fn(),
    addMessage: jest.fn(),
    onWarn: jest.fn(),
    loadRuntime: async () => ({ buildTeamPrFeedback }),
    loadGit: async () => ({ gitPush }),
    ...overrides,
  }
  return { opts, buildTeamPrFeedback, gitPush }
}

describe("buildRunPrFeedback", () => {
  it("resolves the repo + octokit and builds the controller", async () => {
    const { opts, buildTeamPrFeedback } = harness()
    const result = await buildRunPrFeedback(opts)
    expect(result).toBe(controller)
    expect(buildTeamPrFeedback).toHaveBeenCalledTimes(1)
    const params = buildTeamPrFeedback.mock.calls[0]![0]
    expect(params).toMatchObject({
      repo: "acme/app",
      baseBranch: "main",
      runId: "run-1",
      teamId: "team-1",
    })
    // Reviewer is off by default → no runReview wired.
    expect(params.runReview).toBeUndefined()
  })

  it("wires the git push seam to origin with upstream tracking", async () => {
    const { opts, buildTeamPrFeedback, gitPush } = harness()
    await buildRunPrFeedback(opts)
    const params = buildTeamPrFeedback.mock.calls[0]![0]
    await params.git.push("/repo", "feature/x")
    expect(gitPush).toHaveBeenCalledWith("/repo", {
      remote: "origin",
      branch: "feature/x",
      setUpstream: true,
    })
  })

  it("passes runReview only when the reviewer is enabled and a runner is provided", async () => {
    const runPrReview = jest.fn()
    const { opts, buildTeamPrFeedback } = harness({
      config: { enabled: true, reviewer: { enabled: true } },
      runPrReview: runPrReview as unknown as Opts["runPrReview"],
    })
    await buildRunPrFeedback(opts)
    expect(buildTeamPrFeedback.mock.calls[0]![0].runReview).toBe(runPrReview)
  })

  it("does not wire runReview when the reviewer is enabled but no runner is provided", async () => {
    const { opts, buildTeamPrFeedback } = harness({
      config: { enabled: true, reviewer: { enabled: true } },
    })
    await buildRunPrFeedback(opts)
    expect(buildTeamPrFeedback.mock.calls[0]![0].runReview).toBeUndefined()
  })

  it("stays inert (undefined) when the repo does not resolve", async () => {
    const { opts, buildTeamPrFeedback } = harness({ resolveTeamRepo: jest.fn(async () => null) })
    expect(await buildRunPrFeedback(opts)).toBeUndefined()
    expect(buildTeamPrFeedback).not.toHaveBeenCalled()
  })

  it("stays inert (undefined) when credentials do not resolve", async () => {
    const { opts, buildTeamPrFeedback } = harness({
      resolvePrObserveOctokit: jest.fn(async () => null),
    })
    expect(await buildRunPrFeedback(opts)).toBeUndefined()
    expect(buildTeamPrFeedback).not.toHaveBeenCalled()
  })

  it("reports via onWarn and returns undefined when resolution throws", async () => {
    const onWarn = jest.fn()
    const { opts } = harness({
      resolveTeamRepo: jest.fn(async () => {
        throw new Error("git blew up")
      }),
      onWarn,
    })
    expect(await buildRunPrFeedback(opts)).toBeUndefined()
    expect(onWarn).toHaveBeenCalledWith("git blew up")
  })
})
