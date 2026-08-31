/**
 * @jest-environment jsdom
 */

import type { AgentTeam, AgentTeamTask } from "@/types/agent/agent-team"
import type { Issue, IssueProject, IssueRun } from "@/types/issues"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  putAgentTeamDeliveryGraph,
  putAgentTeamDeliveryNodes,
  createAgentTeamRun,
  createAgentTeamChildRun,
} from "@/lib/db/agent-team-runtime"
import {
  AGENT_TEAM_RUN_ADAPTER_ID,
  BUSY_TEAM_STATUSES,
  __setLoadedAgentTeamStoreForTesting,
  agentTeamWorkspaceHref,
  collectDurableArtifacts,
  createAgentTeamRunAdapter,
  createDefaultAgentTeamRunAdapterDeps,
  ensureAgentTeamStoreLoaded,
  issuePriorityToSubAgentPriority,
  type AgentTeamRunAdapterDeps,
} from "./agent-team-adapter"

const mockStart = jest.fn(async () => {})
const mockAbort = jest.fn()
jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: { start: (...args: unknown[]) => mockStart(...(args as [])) },
}))
jest.mock("@/lib/ai/agent/agent-team-runtime", () => ({
  abortTeam: (...args: unknown[]) => mockAbort(...args),
}))
const fakeStoreState = {
  teams: { "team-1": { id: "team-1", name: "Squad", status: "idle" } },
  tasks: { "tt-1": { id: "tt-1", teamId: "team-1", status: "pending" } },
  createTask: jest.fn((input: { title: string }) => ({ id: "tt-created", ...input })),
}
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: { getState: () => fakeStoreState, subscribe: () => () => {} },
}))
import type { IssueRunTarget } from "./types"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN = { kind: "human" } as const

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "iss-1",
    identifier: "MERC-1",
    number: 1,
    projectId: "w1",
    issueProjectId: "ip-1",
    title: "Ship it",
    description: "All of it",
    status: "todo",
    statusCategory: "unstarted",
    priority: "medium",
    assignee: { kind: "team", id: "team-1", label: "Squad" },
    assigneeKind: "team",
    assigneeId: "team-1",
    createdBy: HUMAN,
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function project(over: Partial<IssueProject> = {}): IssueProject {
  return {
    id: "ip-1",
    projectId: "w1",
    key: "MERC",
    name: "Mercury",
    description: "ctx",
    status: "in_progress",
    priority: "none",
    resources: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function target(over: Partial<IssueRunTarget> = {}): IssueRunTarget {
  return { issue: issue(), project: project(), ...over }
}

function team(over: Partial<AgentTeam> = {}): AgentTeam {
  return { id: "team-1", name: "Squad", status: "idle", taskIds: [], ...over } as AgentTeam
}

function teamTask(over: Partial<AgentTeamTask> = {}): AgentTeamTask {
  return {
    id: "tt-1",
    teamId: "team-1",
    title: "MERC-1: Ship it",
    description: "…",
    status: "pending",
    priority: "normal",
    dependencies: [],
    tags: [],
    createdAt: new Date(1),
    order: 0,
    ...over,
  }
}

function run(over: Partial<IssueRun> = {}): IssueRun {
  return {
    id: "run-1",
    issueId: "iss-1",
    projectId: "w1",
    adapterId: AGENT_TEAM_RUN_ADAPTER_ID,
    kind: "agent-team",
    targetId: "team-1",
    targetRef: { taskId: "tt-1" },
    status: "running",
    by: HUMAN,
    startedAt: 1_000,
    updatedAt: 1_000,
    artifacts: [],
    ...over,
  }
}

function makeDeps(over: Partial<AgentTeamRunAdapterDeps> = {}) {
  const created: Parameters<AgentTeamRunAdapterDeps["createTask"]>[0][] = []
  const runs: Parameters<AgentTeamRunAdapterDeps["createRun"]>[0][] = []
  const starts: Array<[string, string]> = []
  const aborts: Array<[string, string]> = []
  let startResolve: () => void = () => {}
  const startPromise = new Promise<void>((resolve) => {
    startResolve = resolve
  })
  const deps: AgentTeamRunAdapterDeps = {
    getTeam: (id) => (id === "team-1" ? team() : undefined),
    getTask: () => undefined,
    createTask: (input) => {
      created.push(input)
      return teamTask({ id: "tt-new", title: input.title })
    },
    startTeam: async (id, origin) => {
      starts.push([id, origin])
      await startPromise
    },
    abortTeam: (id, reason) => {
      aborts.push([id, reason])
    },
    collectArtifacts: async () => [{ label: "art", href: "/a" }],
    createRun: async (input) => {
      runs.push(input)
      return run({ id: "run-new", targetRef: input.targetRef })
    },
    now: () => 42,
    ...over,
  }
  return { deps, created, runs, starts, aborts, resolveStart: () => startResolve() }
}

describe("helpers", () => {
  it("builds hrefs, maps priorities, knows the busy statuses", () => {
    expect(agentTeamWorkspaceHref("t 1")).toBe("/squads?id=t%201")
    expect(issuePriorityToSubAgentPriority("urgent")).toBe("critical")
    expect(issuePriorityToSubAgentPriority("high")).toBe("high")
    expect(issuePriorityToSubAgentPriority("medium")).toBe("normal")
    expect(issuePriorityToSubAgentPriority("low")).toBe("low")
    expect(issuePriorityToSubAgentPriority("none")).toBe("normal")
    expect([...BUSY_TEAM_STATUSES].sort()).toEqual(["executing", "paused", "planning"])
  })
})

describe("canRun", () => {
  it("accepts an idle team and refuses everything else", async () => {
    const adapter = createAgentTeamRunAdapter(makeDeps().deps)
    expect(await adapter.canRun(target())).toEqual({ ok: true })
    expect(await adapter.canRun(target({ issue: issue({ assignee: undefined }) }))).toEqual({
      ok: false,
      reason: "assignee-kind-mismatch",
    })
    expect(
      await adapter.canRun(target({ issue: issue({ assignee: { kind: "agent", id: "c" } }) }))
    ).toMatchObject({ reason: "assignee-kind-mismatch" })
    expect(
      await adapter.canRun(target({ issue: issue({ assignee: { kind: "team", id: "ghost" } }) }))
    ).toEqual({ ok: false, reason: "assignee-not-found", detail: "ghost" })
    const busy = createAgentTeamRunAdapter(
      makeDeps({ getTeam: () => team({ status: "executing" }) }).deps
    )
    expect(await busy.canRun(target())).toEqual({
      ok: false,
      reason: "team-busy",
      detail: "executing",
    })
  })
})

describe("start", () => {
  it("adds a task with issue metadata, records the run, and fires the team without awaiting", async () => {
    const harness = makeDeps()
    const adapter = createAgentTeamRunAdapter(harness.deps)
    const result = await adapter.start(target(), { by: HUMAN, origin: "im" })
    expect(harness.created[0]).toMatchObject({
      teamId: "team-1",
      title: "MERC-1: Ship it",
      description: "All of it\n\nProject context: ctx",
      priority: "normal",
      tags: ["issue", "MERC-1"],
      metadata: { issueId: "iss-1", issueIdentifier: "MERC-1" },
    })
    expect(harness.runs[0]).toMatchObject({
      adapterId: AGENT_TEAM_RUN_ADAPTER_ID,
      kind: "agent-team",
      targetId: "team-1",
      targetRef: { taskId: "tt-new" },
      status: "running",
      now: 42,
    })
    // start returned before the team run finished
    expect(result.id).toBe("run-new")
    expect(harness.starts).toEqual([["team-1", "im"]])
    harness.resolveStart()
  })

  it("routes a start rejection to onStartError and refuses unrunnable targets", async () => {
    const errors: unknown[] = []
    const harness = makeDeps({
      startTeam: async () => {
        throw new Error("no teammates")
      },
      onStartError: (error) => errors.push(error),
    })
    const adapter = createAgentTeamRunAdapter(harness.deps)
    await adapter.start(target(), { by: HUMAN, origin: "interactive" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(errors.map((e) => (e as Error).message)).toEqual(["no teammates"])
    await expect(
      adapter.start(target({ issue: issue({ assignee: undefined }) }), { by: HUMAN, origin: "im" })
    ).rejects.toThrow(/refused/)
  })
})

describe("poll", () => {
  it("settles from the task status and collects artifacts", async () => {
    const done = createAgentTeamRunAdapter(
      makeDeps({ getTask: () => teamTask({ status: "completed", result: "shipped" }) }).deps
    )
    expect(await done.poll(run())).toEqual({
      status: "succeeded",
      summary: "shipped",
      artifacts: [{ label: "art", href: "/a" }],
    })
    const failed = createAgentTeamRunAdapter(
      makeDeps({ getTask: () => teamTask({ status: "failed", error: "nope" }) }).deps
    )
    expect(await failed.poll(run())).toEqual({
      status: "failed",
      error: "nope",
      artifacts: [{ label: "art", href: "/a" }],
    })
    const failedNoError = createAgentTeamRunAdapter(
      makeDeps({ getTask: () => teamTask({ status: "failed" }) }).deps
    )
    expect(await failedNoError.poll(run())).toMatchObject({ error: "team task failed" })
    const cancelled = createAgentTeamRunAdapter(
      makeDeps({ getTask: () => teamTask({ status: "cancelled" }) }).deps
    )
    expect(await cancelled.poll(run())).toEqual({ status: "cancelled" })
  })

  it("stays active while the team is busy or idle, fails when the team stopped or vanished", async () => {
    for (const status of ["planning", "executing", "paused", "idle"] as const) {
      const adapter = createAgentTeamRunAdapter(
        makeDeps({
          getTask: () => teamTask({ status: "pending" }),
          getTeam: () => team({ status }),
        }).deps
      )
      expect(await adapter.poll(run())).toBeNull()
    }
    const ended = createAgentTeamRunAdapter(
      makeDeps({
        getTask: () => teamTask({ status: "in_progress" }),
        getTeam: () => team({ status: "failed" }),
      }).deps
    )
    expect(await ended.poll(run())).toMatchObject({
      status: "failed",
      error: "team run ended (failed) before the task ran",
    })
    const noTeam = createAgentTeamRunAdapter(
      makeDeps({ getTask: () => teamTask(), getTeam: () => undefined }).deps
    )
    expect(await noTeam.poll(run())).toEqual({ status: "failed", error: "team no longer exists" })
    const noTask = createAgentTeamRunAdapter(makeDeps().deps)
    expect(await noTask.poll(run())).toEqual({
      status: "failed",
      error: "team task no longer exists",
    })
    expect(await noTask.poll(run({ targetRef: undefined }))).toEqual({
      status: "failed",
      error: "team task no longer exists",
    })
  })
})

describe("cancel", () => {
  it("aborts the team", async () => {
    const harness = makeDeps()
    await createAgentTeamRunAdapter(harness.deps).cancel!(run())
    expect(harness.aborts).toEqual([["team-1", "issue run run-1 cancelled"]])
  })
})

describe("collectDurableArtifacts", () => {
  it("always links the team workspace, then PRs / branches / sessions of the matching run", async () => {
    expect(await collectDurableArtifacts(run())).toEqual([
      { label: "Team workspace", href: "/squads?id=team-1" },
    ])

    await createAgentTeamRun({
      id: "trun-old",
      teamId: "team-1",
      objective: "o",
      status: "completed",
      priority: 0,
      decisionVersion: 1,
      createdAt: 10,
      updatedAt: 10,
    })
    await createAgentTeamRun({
      id: "trun-1",
      teamId: "team-1",
      objective: "o",
      status: "completed",
      priority: 0,
      decisionVersion: 1,
      createdAt: 2_000,
      updatedAt: 2_000,
    })
    await putAgentTeamDeliveryGraph({
      id: "g1",
      runId: "trun-1",
      status: "completed",
      createdAt: 1,
      updatedAt: 1,
    })
    await putAgentTeamDeliveryNodes([
      {
        id: "n1",
        graphId: "g1",
        runId: "trun-1",
        repositoryId: "r",
        title: "Layer 1",
        order: 0,
        dependsOn: [],
        branch: "b1",
        baseBranch: "main",
        status: "merged",
        pullRequestNumber: 7,
        pullRequestUrl: "https://gh/pr/7",
        createdAt: 1,
        updatedAt: 1,
      } as never,
      {
        id: "n2",
        graphId: "g1",
        runId: "trun-1",
        repositoryId: "r",
        title: "Layer 2",
        order: 1,
        dependsOn: [],
        branch: "b2",
        baseBranch: "main",
        status: "open",
        pullRequestUrl: "https://gh/pr/x",
        createdAt: 1,
        updatedAt: 1,
      } as never,
      {
        id: "n3",
        graphId: "g1",
        runId: "trun-1",
        repositoryId: "r",
        title: "No PR",
        order: 2,
        dependsOn: [],
        branch: "b3",
        baseBranch: "main",
        status: "pending",
        createdAt: 1,
        updatedAt: 1,
      } as never,
    ])
    await createAgentTeamChildRun({
      id: "c1",
      runId: "trun-1",
      teamId: "team-1",
      teammateId: "mate",
      taskId: "tt-1",
      repositoryId: "r",
      status: "completed",
      attempt: 1,
      branch: "feat/x",
      sessionId: "sess-1",
      resourceUsage: {} as never,
      createdAt: 1,
      updatedAt: 1,
    })
    await createAgentTeamChildRun({
      id: "c2",
      runId: "trun-1",
      teamId: "team-1",
      teammateId: "other",
      taskId: "tt-other",
      repositoryId: "r",
      status: "completed",
      attempt: 1,
      branch: "feat/other",
      resourceUsage: {} as never,
      createdAt: 1,
      updatedAt: 1,
    })

    expect(await collectDurableArtifacts(run())).toEqual([
      { label: "Team workspace", href: "/squads?id=team-1" },
      { label: "PR #7", href: "https://gh/pr/7" },
      { label: "Layer 2", href: "https://gh/pr/x" },
      { label: "Branch feat/x", href: "/squads?id=team-1&tab=worktrees" },
      { label: "Session (mate)", href: "/?session=sess-1" },
    ])
    // Without a task ref every child run counts.
    const all = await collectDurableArtifacts(run({ targetRef: undefined }))
    expect(all.filter((a) => a.label.startsWith("Branch")).map((a) => a.label)).toEqual([
      "Branch feat/x",
      "Branch feat/other",
    ])
  })
})

describe("default deps", () => {
  afterEach(() => __setLoadedAgentTeamStoreForTesting(null))

  it("read nothing until the store is loaded, then read the store", async () => {
    __setLoadedAgentTeamStoreForTesting(null)
    const deps = createDefaultAgentTeamRunAdapterDeps()
    expect(deps.getTeam("team-1")).toBeUndefined()
    expect(deps.getTask("tt-1")).toBeUndefined()
    expect(() => deps.createTask({ teamId: "team-1", title: "x", description: "" })).toThrow(
      /not loaded/
    )

    const store = await ensureAgentTeamStoreLoaded()
    expect(await ensureAgentTeamStoreLoaded()).toBe(store)
    expect(deps.getTeam("team-1")).toMatchObject({ id: "team-1" })
    expect(deps.getTask("tt-1")).toMatchObject({ id: "tt-1" })
    expect(deps.createTask({ teamId: "team-1", title: "x", description: "" })).toMatchObject({
      id: "tt-created",
    })
    await deps.startTeam("team-1", "im")
    expect(mockStart).toHaveBeenCalledWith("team-1", { origin: "im" })
    deps.abortTeam("team-1", "why")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockAbort).toHaveBeenCalledWith("team-1", expect.any(Error))
    expect(deps.now()).toBeGreaterThan(0)
  })
})
