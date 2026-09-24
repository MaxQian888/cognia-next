/**
 * @jest-environment jsdom
 */

import type { Issue, IssueActor, IssueRun } from "@/types/issues"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue } from "@/lib/db/issues"
import { createIssueRun, listActiveIssueRunIssueIds, settleIssueRun } from "@/lib/db/issue-runs"
import { beginAgentTaskAttempt, createAgentTask } from "@/lib/db/agent-tasks"
import { listActiveAgentRuns, type ActiveAgentRunDeps } from "./active-agent-runs"

const HUMAN: IssueActor = { kind: "human" }

function run(over: Partial<IssueRun>): IssueRun {
  return {
    id: "irun_1",
    issueId: "iss_1",
    projectId: "w1",
    adapterId: "agent-task",
    kind: "agent-task",
    targetId: "agent-task:1",
    status: "running",
    by: HUMAN,
    startedAt: 10,
    updatedAt: 10,
    artifacts: [],
    ...over,
  }
}

function deps(runs: IssueRun[], over: Partial<ActiveAgentRunDeps> = {}): ActiveAgentRunDeps {
  return {
    listActiveRuns: async () => runs,
    getIssue: async (id) =>
      ({ id, identifier: `MERC-${id.slice(-1)}`, title: `Issue ${id}` }) as Issue,
    latestTaskSessionId: async () => undefined,
    ...over,
  }
}

describe("listActiveAgentRuns (unit)", () => {
  it("links each run kind to where it can be watched", async () => {
    const entries = await listActiveAgentRuns(
      "w1",
      deps(
        [
          run({ id: "r-task", issueId: "iss_1", targetId: "agent-task:1", startedAt: 30 }),
          run({
            id: "r-team",
            issueId: "iss_2",
            adapterId: "agent-team",
            kind: "agent-team",
            targetId: "team 7",
            status: "queued",
            startedAt: 20,
          }),
          run({
            id: "r-gh",
            issueId: "iss_3",
            adapterId: "github-loop",
            kind: "github-loop",
            targetId: "job-1",
            startedAt: 10,
          }),
        ],
        { latestTaskSessionId: async (taskId) => (taskId === "agent-task:1" ? "s 1" : undefined) }
      )
    )

    expect(entries).toEqual([
      expect.objectContaining({
        runId: "r-task",
        issueIdentifier: "MERC-1",
        issueTitle: "Issue iss_1",
        status: "running",
        href: "/?session=s%201",
        linkKind: "session",
        issueHref: "/issues?id=iss_1",
      }),
      expect.objectContaining({
        runId: "r-team",
        status: "queued",
        href: "/squads?id=team%207",
        linkKind: "squad",
      }),
      expect.objectContaining({
        runId: "r-gh",
        href: "/issues?id=iss_3",
        linkKind: "issue",
      }),
    ])
  })

  it("falls back to the Character task board before an attempt has a session", async () => {
    const [entry] = await listActiveAgentRuns("w1", deps([run({})]))
    expect(entry).toMatchObject({ href: "/settings?section=characters", linkKind: "agent-board" })
  })

  it("counts one entry per issue (the newest active run) and skips terminal rows", async () => {
    const entries = await listActiveAgentRuns(
      "w1",
      deps([
        run({ id: "newest", issueId: "iss_1", startedAt: 50 }),
        run({ id: "older", issueId: "iss_1", startedAt: 40, status: "queued" }),
        run({ id: "done", issueId: "iss_2", startedAt: 30, status: "succeeded" }),
      ])
    )
    expect(entries.map((entry) => entry.runId)).toEqual(["newest"])
  })

  it("keeps a run whose issue row is gone, without inventing a title", async () => {
    const [entry] = await listActiveAgentRuns(
      "w1",
      deps([run({})], { getIssue: async () => undefined })
    )
    expect(entry.issueTitle).toBeUndefined()
    expect(entry.issueIdentifier).toBeUndefined()
    expect(entry.issueHref).toBe("/issues?id=iss_1")
  })
})

describe("listActiveAgentRuns (Dexie)", () => {
  const dbFixture = createDbTestFixture()
  beforeAll(dbFixture.initialize)
  beforeEach(dbFixture.restore)
  afterAll(dbFixture.dispose)

  it("lists exactly the issues the old tile counted, with live session links", async () => {
    const container = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" }))
      .id
    const issue = (name: string) =>
      createIssue({ projectId: "w1", issueProjectId: container, title: name, createdBy: HUMAN })
    const first = await issue("Write the docs")
    const second = await issue("Fix the build")
    const finished = await issue("Already done")

    const task = await createAgentTask({
      agentId: "char-1",
      projectId: "w1",
      title: "Write the docs",
      description: "",
    })
    await beginAgentTaskAttempt(task.id, { sessionId: "session-42" })
    await createIssueRun({
      issueId: first.id,
      projectId: "w1",
      adapterId: "agent-task",
      kind: "agent-task",
      targetId: task.id,
      by: HUMAN,
      now: 2,
    })
    await createIssueRun({
      issueId: second.id,
      projectId: "w1",
      adapterId: "agent-team",
      kind: "agent-team",
      targetId: "team-1",
      status: "queued",
      by: HUMAN,
      now: 1,
    })
    const settled = await createIssueRun({
      issueId: finished.id,
      projectId: "w1",
      adapterId: "agent-task",
      kind: "agent-task",
      targetId: "agent-task:gone",
      by: HUMAN,
      now: 3,
    })
    await settleIssueRun(settled.id, { status: "succeeded" })

    const entries = await listActiveAgentRuns("w1")
    const counted = await listActiveIssueRunIssueIds("w1")

    expect(entries).toHaveLength(counted.size)
    expect(new Set(entries.map((entry) => entry.issueId))).toEqual(counted)
    expect(entries).toEqual([
      expect.objectContaining({
        issueId: first.id,
        issueTitle: "Write the docs",
        href: "/?session=session-42",
        linkKind: "session",
      }),
      expect.objectContaining({
        issueId: second.id,
        issueTitle: "Fix the build",
        status: "queued",
        href: "/squads?id=team-1",
      }),
    ])
    expect(await listActiveAgentRuns("other-workspace")).toEqual([])
  })
})
