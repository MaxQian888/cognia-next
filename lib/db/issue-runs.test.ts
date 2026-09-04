/**
 * @jest-environment jsdom
 */

import type { IssueActor } from "@/types/issues"
import { createDbTestFixture } from "./test-fixture"
import { createIssueProject, deleteIssueProject } from "./issue-projects"
import { createIssue, deleteIssue } from "./issues"
import { listIssueEvents } from "./issue-events"
import {
  createIssueRun,
  deleteIssueRuns,
  deleteIssueRunsForIssues,
  getIssueRun,
  getIssueRunByTarget,
  hasActiveIssueRun,
  linkIssueRunArtifact,
  listActiveIssueRunIssueIds,
  listIssueRuns,
  mapIssueRunsByTarget,
  markIssueRunRunning,
  settleIssueRun,
} from "./issue-runs"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN: IssueActor = { kind: "human" }

let projectId: string
let issueId: string

beforeEach(async () => {
  projectId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
  issueId = (
    await createIssue({ projectId: "w1", issueProjectId: projectId, title: "x", createdBy: HUMAN })
  ).id
})

function start(over: Partial<Parameters<typeof createIssueRun>[0]> = {}) {
  return createIssueRun({
    issueId,
    projectId: "w1",
    adapterId: "agent-task",
    kind: "agent-task",
    targetId: "agent-task:1",
    by: HUMAN,
    ...over,
  })
}

async function kindsOf(id: string) {
  return (await listIssueEvents({ issueId: id })).map((e) => e.kind)
}

describe("createIssueRun", () => {
  it("writes a running row and appends run_started in one go", async () => {
    const run = await start()
    expect(run.status).toBe("running")
    expect(run.artifacts).toEqual([])
    expect(await getIssueRun(run.id)).toEqual(run)
    expect(await kindsOf(issueId)).toEqual(["created", "run_started"])
  })

  it("honours an explicit queued status and targetRef", async () => {
    const run = await start({ status: "queued", targetRef: { taskId: "tt-1" }, now: 5 })
    expect(run.status).toBe("queued")
    expect(run.targetRef).toEqual({ taskId: "tt-1" })
    expect(run.startedAt).toBe(5)
  })
})

describe("listIssueRuns", () => {
  it("filters by issue, project, status and activeOnly, newest first", async () => {
    const a = await start({ now: 1 })
    const b = await start({ now: 2, status: "queued" })
    await settleIssueRun(a.id, { status: "succeeded" })
    // A second workspace needs its own container: an issue whose workspace
    // disagrees with its container's is refused at write time.
    const otherContainer = (
      await createIssueProject({ projectId: "w2", name: "Venus", key: "VEN" })
    ).id
    const other = await createIssue({
      projectId: "w2",
      issueProjectId: otherContainer,
      title: "y",
      createdBy: HUMAN,
    })
    const c = await start({ issueId: other.id, projectId: "w2", now: 3 })

    expect((await listIssueRuns({ issueId })).map((r) => r.id)).toEqual([b.id, a.id])
    expect((await listIssueRuns({ issueId, status: "succeeded" })).map((r) => r.id)).toEqual([a.id])
    expect((await listIssueRuns({ issueId, activeOnly: true })).map((r) => r.id)).toEqual([b.id])
    expect((await listIssueRuns({ projectId: "w2" })).map((r) => r.id)).toEqual([c.id])
    expect((await listIssueRuns({ projectId: "w1", status: "queued" })).map((r) => r.id)).toEqual([
      b.id,
    ])
    expect((await listIssueRuns({ status: "running" })).map((r) => r.id)).toEqual([c.id])
    expect((await listIssueRuns({ activeOnly: true })).map((r) => r.id)).toEqual([c.id, b.id])
    expect(await listIssueRuns()).toHaveLength(3)
  })
})

describe("active-run queries", () => {
  it("hasActiveIssueRun / listActiveIssueRunIssueIds track queued and running only", async () => {
    expect(await hasActiveIssueRun(issueId)).toBe(false)
    const queued = await start({ status: "queued" })
    expect(await hasActiveIssueRun(issueId)).toBe(true)
    expect(await listActiveIssueRunIssueIds("w1")).toEqual(new Set([issueId]))
    expect(await listActiveIssueRunIssueIds("w-other")).toEqual(new Set())

    await markIssueRunRunning(queued.id)
    expect((await getIssueRun(queued.id))!.status).toBe("running")
    expect(await hasActiveIssueRun(issueId)).toBe(true)

    await settleIssueRun(queued.id, { status: "failed", error: "boom" })
    expect(await hasActiveIssueRun(issueId)).toBe(false)
    expect(await listActiveIssueRunIssueIds("w1")).toEqual(new Set())
  })

  it("markIssueRunRunning is a no-op unless the run is queued", async () => {
    const running = await start()
    await markIssueRunRunning(running.id, 99)
    expect((await getIssueRun(running.id))!.updatedAt).not.toBe(99)
    await markIssueRunRunning("missing")
  })
})

describe("target lookups", () => {
  it("getIssueRunByTarget returns the newest run of that kind for the target", async () => {
    await start({ targetId: "shared", now: 1 })
    const newer = await start({ targetId: "shared", now: 2 })
    await start({ targetId: "shared", kind: "agent-team", adapterId: "agent-team", now: 3 })
    expect((await getIssueRunByTarget("agent-task", "shared"))!.id).toBe(newer.id)
    expect(await getIssueRunByTarget("github-loop", "shared")).toBeUndefined()
    expect(await getIssueRunByTarget("agent-task", "nope")).toBeUndefined()
  })

  it("mapIssueRunsByTarget indexes the newest run per target for a kind", async () => {
    await start({ targetId: "t1", now: 1 })
    const t1 = await start({ targetId: "t1", now: 2 })
    const t2 = await start({ targetId: "t2", now: 1 })
    await start({ targetId: "t3", kind: "agent-team", adapterId: "agent-team" })
    const map = await mapIssueRunsByTarget("w1", "agent-task")
    expect([...map.keys()].sort()).toEqual(["t1", "t2"])
    expect(map.get("t1")!.id).toBe(t1.id)
    expect(map.get("t2")!.id).toBe(t2.id)
  })
})

describe("linkIssueRunArtifact", () => {
  it("appends the artifact and an artifact_linked event, once per href", async () => {
    const run = await start()
    await linkIssueRunArtifact(run.id, { label: "PR #1", href: "https://x/1" })
    await linkIssueRunArtifact(run.id, { label: "PR #1 again", href: "https://x/1" })
    await linkIssueRunArtifact("missing", { label: "n", href: "h" })
    expect((await getIssueRun(run.id))!.artifacts).toEqual([
      { label: "PR #1", href: "https://x/1" },
    ])
    expect(await kindsOf(issueId)).toEqual(["created", "run_started", "artifact_linked"])
  })
})

describe("settleIssueRun", () => {
  it("succeeded: stamps endedAt, summary, artifacts and run_succeeded", async () => {
    const run = await start()
    const settled = await settleIssueRun(
      run.id,
      { status: "succeeded", summary: "did it", artifacts: [{ label: "branch", href: "b" }] },
      77
    )
    expect(settled).toMatchObject({
      status: "succeeded",
      endedAt: 77,
      summary: "did it",
      artifacts: [{ label: "branch", href: "b" }],
    })
    expect(await kindsOf(issueId)).toEqual([
      "created",
      "run_started",
      "artifact_linked",
      "run_succeeded",
    ])
    const events = await listIssueEvents({ issueId })
    expect(events.at(-1)!.payload).toMatchObject({ kind: "run_succeeded", summary: "did it" })
  })

  it("failed / cancelled: records the error and run_failed", async () => {
    const a = await start()
    const b = await start()
    expect((await settleIssueRun(a.id, { status: "failed", error: "boom" }))!.error).toBe("boom")
    expect((await settleIssueRun(b.id, { status: "cancelled" }))!.error).toBe("cancelled")
    const events = await listIssueEvents({ issueId })
    expect(events.filter((e) => e.kind === "run_failed")).toHaveLength(2)
  })

  it("is one-shot: a second settle or a missing run returns undefined", async () => {
    const run = await start()
    await settleIssueRun(run.id, { status: "succeeded" })
    expect(await settleIssueRun(run.id, { status: "failed", error: "late" })).toBeUndefined()
    expect(await settleIssueRun("missing", { status: "succeeded" })).toBeUndefined()
    expect((await getIssueRun(run.id))!.status).toBe("succeeded")
  })

  it("does not duplicate an artifact already linked", async () => {
    const run = await start()
    await linkIssueRunArtifact(run.id, { label: "a", href: "h" })
    const settled = await settleIssueRun(run.id, {
      status: "succeeded",
      artifacts: [{ label: "a2", href: "h" }],
    })
    expect(settled!.artifacts).toEqual([{ label: "a", href: "h" }])
  })
})

describe("cascade", () => {
  it("deleteIssueRuns / deleteIssueRunsForIssues remove only the targeted issues' runs", async () => {
    const other = await createIssue({
      projectId: "w1",
      issueProjectId: projectId,
      title: "y",
      createdBy: HUMAN,
    })
    await start()
    await start({ issueId: other.id })
    await deleteIssueRuns(issueId)
    expect(await listIssueRuns({ issueId })).toEqual([])
    expect(await listIssueRuns({ issueId: other.id })).toHaveLength(1)
    await deleteIssueRunsForIssues([])
    await deleteIssueRunsForIssues([other.id])
    expect(await listIssueRuns({ issueId: other.id })).toEqual([])
  })

  it("deleteIssue and deleteIssueProject cascade to runs", async () => {
    const other = await createIssue({
      projectId: "w1",
      issueProjectId: projectId,
      title: "y",
      createdBy: HUMAN,
    })
    await start()
    await start({ issueId: other.id })
    await deleteIssue(issueId)
    expect(await listIssueRuns({ issueId })).toEqual([])
    await deleteIssueProject(projectId)
    expect(await listIssueRuns({ issueId: other.id })).toEqual([])
  })
})
