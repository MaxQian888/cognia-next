// Wiring-proof integration test for the PR feedback runtime glue: a failing-CI
// PR observed through the real controller + reaction engine lands a
// `review_pickup` mailbox message and a persisted `ci_failed` observation row.
// Uses fake-indexeddb (real Dexie path) + an injected timer harness + a fake
// octokit.

import {
  buildTeamPrFeedback,
  type BuildTeamPrFeedbackParams,
  type PrFeedbackMailboxInput,
  type PrFeedbackNotifyInput,
} from "./runtime"
import type { OctokitLike } from "@/lib/github/pr-observe/types"
import type { TimerHandle } from "./observer"
import type { RunReview } from "./reviewer"
import type { PromotionWorkspaceHandle } from "@/lib/ai/agent/team/workspace/promotion"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"

jest.setTimeout(30_000)

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})

// ── harness ────────────────────────────────────────────────────────────────

function harness() {
  let now = 1_000_000
  let seq = 0
  const timers: Array<{
    at: number
    fn: () => void | Promise<void>
    handle: TimerHandle
    id: number
  }> = []
  const timerDeps = {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const handle: TimerHandle = { cancelled: false }
      timers.push({ at: now + ms, fn, handle, id: seq++ })
      return handle
    },
    clearTimer: (h: TimerHandle) => {
      h.cancelled = true
    },
  }
  async function tick(): Promise<boolean> {
    const live = timers.filter((t) => !t.handle.cancelled)
    if (live.length === 0) return false
    live.sort((a, b) => a.at - b.at || a.id - b.id)
    const t = live[0]
    timers.splice(timers.indexOf(t), 1)
    now = Math.max(now, t.at)
    await t.fn()
    return true
  }
  return { timerDeps, tick }
}

type Handler = { status?: number; data?: unknown } | ((p: Record<string, unknown>) => unknown)
function makeOctokit(routes: Record<string, Handler>): OctokitLike & { request: jest.Mock } {
  const request = jest.fn(async (route: string, params: Record<string, unknown> = {}) => {
    const h = routes[route]
    if (h === undefined) throw { status: 404 }
    const res = typeof h === "function" ? h(params) : h
    if (res instanceof Error) throw res
    return {
      status: (res as { status?: number }).status ?? 200,
      headers: {},
      data: (res as { data?: unknown }).data,
    }
  })
  return { request } as OctokitLike & { request: jest.Mock }
}

function prDetail(number: number, over: Record<string, unknown> = {}) {
  return {
    number,
    state: "open",
    head: { sha: "s1", ref: "agent/run-1/dev/t1" },
    base: { ref: "main" },
    mergeable: true,
    mergeable_state: "unstable",
    title: "Fix bug",
    user: { login: "dev" },
    html_url: `https://gh/acme/app/pull/${number}`,
    ...over,
  }
}

function ciRoutes(
  number: number,
  discovery: unknown,
  ci: "failing" | "passing"
): Record<string, Handler> {
  const checkRuns =
    ci === "failing"
      ? [
          {
            name: "build",
            status: "completed",
            conclusion: "failure",
            details_url: "u/job/9",
            id: 9,
          },
        ]
      : [{ name: "build", status: "completed", conclusion: "success" }]
  return {
    "GET /repos/{owner}/{repo}/pulls": { status: 200, data: discovery },
    "GET /repos/{owner}/{repo}/pulls/{pull_number}": { status: 200, data: prDetail(number) },
    "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": {
      status: 200,
      data: { check_runs: checkRuns },
    },
    "GET /repos/{owner}/{repo}/commits/{ref}/status": {
      status: 200,
      data: { state: ci === "failing" ? "failure" : "success", statuses: [] },
    },
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": { status: 200, data: [] },
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments": { status: 200, data: [] },
    "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs": {
      status: 200,
      data: "err line 1\nerr line 2",
    },
  }
}

const handle: PromotionWorkspaceHandle = {
  key: "t1",
  logicalRootId: "app",
  runId: "run-1",
  teammateName: "dev",
  taskId: "t1",
  branch: "agent/run-1/dev/t1",
  path: "/wt",
}

function makeParams(
  octokit: OctokitLike,
  timerDeps: ReturnType<typeof harness>["timerDeps"],
  over: Partial<BuildTeamPrFeedbackParams> = {}
): {
  params: BuildTeamPrFeedbackParams
  messages: PrFeedbackMailboxInput[]
  notes: PrFeedbackNotifyInput[]
  push: jest.Mock
} {
  const messages: PrFeedbackMailboxInput[] = []
  const notes: PrFeedbackNotifyInput[] = []
  const push = jest.fn(async () => {})
  const params: BuildTeamPrFeedbackParams = {
    runId: "run-1",
    teamId: "team-a",
    leadId: "lead",
    repo: "acme/app",
    baseBranch: "main",
    octokit,
    config: { enabled: true },
    teammates: [{ id: "m1", name: "dev" }],
    tasks: [{ id: "t1", title: "Fix bug" }],
    notify: (n) => notes.push(n),
    addMessage: (m) => messages.push(m),
    git: { push },
    timers: timerDeps,
    ...over,
  }
  return { params, messages, notes, push }
}

afterAll(dbFixture.dispose)

describe("buildTeamPrFeedback", () => {
  it("routes a review_pickup nudge and persists a ci_failed observation", async () => {
    const { timerDeps, tick } = harness()
    const octokit = makeOctokit(
      ciRoutes(12, [{ number: 12, html_url: "https://gh/acme/app/pull/12" }], "failing")
    )
    const { params, messages, notes } = makeParams(octokit, timerDeps)
    const fb = buildTeamPrFeedback(params)

    await fb.trackAll([handle])
    const settled = fb.settle(0)
    await tick()
    await settled
    fb.dispose()

    expect(messages).toHaveLength(1)
    expect(messages[0].structuredPayload).toMatchObject({
      type: "nudge",
      nudgeType: "review_pickup",
    })
    expect(messages[0].recipientId).toBe("lead")
    expect(messages[0].content).toContain("CI is failing")
    expect(notes[0].dedupeKey).toContain("prnudge:run-1")

    const rows = await getDb().teamPrObservations.where("teamId").equals("team-a").toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].derivedStatus).toBe("ci_failed")
    expect(rows[0].prUrl).toBe("https://gh/acme/app/pull/12")
    expect(rows[0].lastNudgeSignature.seen).toBeDefined()
  })

  it("auto-publishes a PR before observing when publishPr is set", async () => {
    const { timerDeps, tick } = harness()
    const routes = ciRoutes(20, [], "failing") // discovery finds none → publish creates it
    routes["POST /repos/{owner}/{repo}/pulls"] = {
      status: 201,
      data: { number: 20, html_url: "https://gh/acme/app/pull/20" },
    }
    const octokit = makeOctokit(routes)
    const { params, messages, push } = makeParams(octokit, timerDeps, {
      config: { enabled: true, publishPr: true },
    })
    const fb = buildTeamPrFeedback(params)

    await fb.trackAll([handle])
    const settled = fb.settle(0)
    await tick()
    await settled
    fb.dispose()

    expect(push).toHaveBeenCalledWith("/wt", "agent/run-1/dev/t1")
    expect(messages[0]?.structuredPayload.nudgeType).toBe("review_pickup")
    const rows = await getDb().teamPrObservations.where("teamId").equals("team-a").toArray()
    expect(rows[0].prUrl).toBe("https://gh/acme/app/pull/20")
  })

  it("runs the internal reviewer and routes its changes_requested verdict", async () => {
    const { timerDeps, tick } = harness()
    // A clean PR (no CI/review nudge) so the only nudge is the reviewer's.
    const octokit = makeOctokit(
      ciRoutes(30, [{ number: 30, html_url: "https://gh/acme/app/pull/30" }], "passing")
    )
    const runReview: RunReview = jest.fn(async () => ({
      verdict: "changes_requested" as const,
      body: "fix the null check",
    }))
    const { params, messages } = makeParams(octokit, timerDeps, {
      config: { enabled: true, reviewer: { enabled: true } },
      runReview,
    })
    const fb = buildTeamPrFeedback(params)

    await fb.trackAll([handle])
    const settled = fb.settle(0)
    await tick()
    await settled
    fb.dispose()

    expect(runReview).toHaveBeenCalled()
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toContain("internal code reviewer requested changes")
    expect(messages[0].content).toContain("fix the null check")
  })

  it("surfaces a publish failure via onError and still observes by branch", async () => {
    const { timerDeps, tick } = harness()
    const routes = ciRoutes(50, [], "failing")
    routes["POST /repos/{owner}/{repo}/pulls"] = () => {
      throw { status: 500 }
    }
    const octokit = makeOctokit(routes)
    const onError = jest.fn()
    const { params, push } = makeParams(octokit, timerDeps, {
      config: { enabled: true, publishPr: true },
      onError,
    })
    const fb = buildTeamPrFeedback(params)

    await fb.trackAll([handle])
    const settled = fb.settle(0)
    await tick()
    await settled
    fb.dispose()

    expect(push).toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "agent/run-1/dev/t1" }),
      { status: 500 }
    )
  })

  it("does not run the reviewer when reviewer is enabled but no runReview seam is wired", async () => {
    const { timerDeps, tick } = harness()
    const octokit = makeOctokit(
      ciRoutes(60, [{ number: 60, html_url: "https://gh/acme/app/pull/60" }], "passing")
    )
    const { params, messages } = makeParams(octokit, timerDeps, {
      config: { enabled: true, reviewer: { enabled: true } },
    })
    const fb = buildTeamPrFeedback(params)

    await fb.trackAll([handle])
    const settled = fb.settle(0)
    await tick()
    await settled
    fb.dispose()

    // A clean PR with no reviewer seam → no nudge at all.
    expect(messages).toHaveLength(0)
  })

  it("falls back to the lead as recipient when the teammate name is unknown", async () => {
    const { timerDeps, tick } = harness()
    const octokit = makeOctokit(
      ciRoutes(40, [{ number: 40, html_url: "https://gh/acme/app/pull/40" }], "failing")
    )
    const { params, messages } = makeParams(octokit, timerDeps, { teammates: [] })
    const fb = buildTeamPrFeedback(params)

    await fb.trackAll([handle])
    const settled = fb.settle(0)
    await tick()
    await settled
    fb.dispose()

    expect(messages[0].recipientId).toBe("lead")
  })
})
