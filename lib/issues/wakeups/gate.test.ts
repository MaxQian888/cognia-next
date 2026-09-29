/**
 * @jest-environment jsdom
 */

import type { IssueActor, IssueWakeupEvidence } from "@/types/issues"
import type { ScheduledTask } from "@/types/scheduler"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue } from "@/lib/db/issues"
import { createIssueRun } from "@/lib/db/issue-runs"
import { registerIssueRunAdapter, resetIssueRunRegistry } from "@/lib/issues/run/registry"
import type { IssueRunAdapter } from "@/lib/issues/run/types"
import { WAKEUP_BARRIER_KEY, WAKEUP_RELEASE_FLAG, createIssueWakeupFireGate } from "./gate"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)
afterEach(resetIssueRunRegistry)

const HUMAN: IssueActor = { kind: "human" }
let containerId: string

beforeEach(async () => {
  containerId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
})

const makeIssue = (over: Partial<Parameters<typeof createIssue>[0]> = {}) =>
  createIssue({
    projectId: "w1",
    issueProjectId: containerId,
    title: "x",
    createdBy: HUMAN,
    status: "todo",
    ...over,
  })

function rule(issueId: string, payload: Record<string, unknown> = {}): ScheduledTask {
  return {
    id: "wk1",
    name: "w",
    type: "issue-wakeup",
    trigger: { type: "event", eventType: "issue:activity", eventSource: `issue:${issueId}` },
    payload: { issueId, instruction: "x", ...payload },
    config: { timeout: 1, maxRetries: 0, retryDelay: 0, runMissedOnStartup: false },
    notification: { onStart: false, onComplete: false, onError: true },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }
}

const event = (data: Record<string, unknown>) => ({ type: "issue:activity", data })
const activity = (issueId: string, over: Record<string, unknown> = {}) => ({
  issueId,
  subjectId: issueId,
  kind: "commented",
  ts: 1,
  actor: HUMAN,
  chain: [],
  summary: "comment",
  ...over,
})

function setup() {
  const held: IssueWakeupEvidence[][] = []
  const gate = createIssueWakeupFireGate({
    hold: async (_taskId, append) => {
      held.push(append([]))
    },
  })
  return { gate, held }
}

function adapter(sessions: string[] | null): IssueRunAdapter {
  return {
    id: "fake",
    kind: "agent-task",
    canRun: async () => ({ ok: true }),
    start: async () => {
      throw new Error("unused")
    },
    poll: async () => null,
    ...(sessions ? { sessionIds: async () => sessions } : {}),
  }
}

const activeRun = (issueId: string) =>
  createIssueRun({
    issueId,
    projectId: "w1",
    adapterId: "fake",
    kind: "agent-task",
    targetId: "t",
    by: HUMAN,
  })

it("fires on a matching event", async () => {
  const issue = await makeIssue()
  const { gate } = setup()
  await expect(
    gate(rule(issue.id, { match: { kinds: ["commented"] } }), event(activity(issue.id)))
  ).resolves.toEqual({ fire: true })
})

it("never fires on its own run's echo", async () => {
  const issue = await makeIssue()
  const { gate } = setup()
  await expect(
    gate(rule(issue.id), event(activity(issue.id, { originTaskId: "wk1" })))
  ).resolves.toEqual({ fire: false, reason: "own-run" })
})

it("does not fire when the match fails or the data is not issue activity", async () => {
  const issue = await makeIssue()
  const { gate } = setup()
  await expect(
    gate(rule(issue.id, { match: { kinds: ["status_changed"] } }), event(activity(issue.id)))
  ).resolves.toMatchObject({ fire: false, reason: "no-match" })
  await expect(gate(rule(issue.id), { type: "issue:activity" })).resolves.toMatchObject({
    fire: false,
    reason: "not-issue-activity",
  })
})

describe("children-done", () => {
  const children = (parentId: string, payload: Record<string, unknown> = {}) =>
    rule(parentId, {
      match: { kinds: ["child_status_changed", "child_stage_changed"] },
      condition: { kind: "children-done" },
      ...payload,
    })
  const childMoved = (parentId: string, subjectId: string, from: string, to: string) =>
    event(activity(parentId, { kind: "child_status_changed", subjectId, from, to }))

  it("fires when the last child moves into a finished state, carrying the barrier", async () => {
    const parent = await makeIssue()
    await makeIssue({ parentId: parent.id, status: "done" })
    const b = await makeIssue({ parentId: parent.id, status: "canceled" })
    const { gate } = setup()
    await expect(
      gate(children(parent.id), childMoved(parent.id, b.id, "in_review", "canceled"))
    ).resolves.toEqual({ fire: true, payload: { [WAKEUP_BARRIER_KEY]: { kind: "all" } } })
  })

  it("waits while a child is still open, and ignores changes among finished children", async () => {
    const parent = await makeIssue()
    const done = await makeIssue({ parentId: parent.id, status: "done" })
    const open = await makeIssue({ parentId: parent.id, status: "todo" })
    const { gate } = setup()
    await expect(
      gate(children(parent.id), childMoved(parent.id, open.id, "backlog", "todo"))
    ).resolves.toMatchObject({ fire: false, reason: "condition-unmet" })
    const { getDb } = await import("@/lib/db/schema")
    await getDb().issues.update(open.id, { status: "canceled", statusCategory: "canceled" })
    // Every child is finished, but this change was done → canceled: no advance.
    await expect(
      gate(children(parent.id), childMoved(parent.id, done.id, "canceled", "done"))
    ).resolves.toMatchObject({ fire: false, reason: "condition-unmet" })
  })

  it("hands off stage by stage on the platform rule", async () => {
    const parent = await makeIssue()
    const first = await makeIssue({ parentId: parent.id, status: "done", stage: 1 })
    await makeIssue({ parentId: parent.id, status: "todo", stage: 2 })
    const { gate } = setup()
    const platform = children(parent.id, { system: "children-done" })
    await expect(
      gate(platform, childMoved(parent.id, first.id, "in_review", "done"))
    ).resolves.toEqual({
      fire: true,
      payload: { [WAKEUP_BARRIER_KEY]: { kind: "stage", stage: 1 } },
    })
    // An author's rule without a stage waits for everything.
    await expect(
      gate(children(parent.id), childMoved(parent.id, first.id, "in_review", "done"))
    ).resolves.toMatchObject({ fire: false })
  })

  it("fires an author's stage rule, and when a stage change completes a stage", async () => {
    const parent = await makeIssue()
    await makeIssue({ parentId: parent.id, status: "done", stage: 1 })
    const moved = await makeIssue({ parentId: parent.id, status: "todo", stage: 2 })
    const { gate } = setup()
    const stageOne = children(parent.id, { condition: { kind: "children-done", stage: 1 } })
    // The open child left stage 1 for stage 2: stage 1 is finished now.
    const stageMove = event(
      activity(parent.id, {
        kind: "child_stage_changed",
        subjectId: moved.id,
        fromStage: 1,
        toStage: 2,
      })
    )
    await expect(gate(stageOne, stageMove)).resolves.toEqual({
      fire: true,
      payload: { [WAKEUP_BARRIER_KEY]: { kind: "stage", stage: 1 } },
    })
    // The same move reported from an unstaged start does not change stage 1.
    const fromUnstaged = event(
      activity(parent.id, {
        kind: "child_stage_changed",
        subjectId: moved.id,
        fromStage: null,
        toStage: 2,
      })
    )
    await expect(gate(stageOne, fromUnstaged)).resolves.toMatchObject({ fire: false })
  })

  it("holds the platform hand-off while the parent sits in backlog", async () => {
    const parent = await makeIssue({ status: "backlog" })
    const first = await makeIssue({ parentId: parent.id, status: "done", stage: 1 })
    await makeIssue({ parentId: parent.id, status: "todo", stage: 2 })
    const { gate, held } = setup()
    const platform = children(parent.id, { system: "children-done" })
    await expect(
      gate(platform, childMoved(parent.id, first.id, "in_review", "done"))
    ).resolves.toEqual({ fire: false, reason: "held-parent-in-backlog" })
    expect(held).toHaveLength(1)
    expect(held[0][0]).toMatchObject({ kind: "child_status_changed", subjectId: first.id })
    expect(held[0][0].summary).toMatch(/stage 1/)
    // An author's rule on the same parent is not held.
    const authored = children(parent.id, { condition: { kind: "children-done", stage: 1 } })
    await expect(
      gate(authored, childMoved(parent.id, first.id, "in_review", "done"))
    ).resolves.toMatchObject({ fire: true })
  })
})

it("releases a held hand-off once when the parent leaves backlog, not on other moves", async () => {
  const parent = await makeIssue({ status: "todo" })
  const deferred: IssueWakeupEvidence[] = [
    { kind: "child_status_changed", subjectId: "c1", ts: 0, summary: "stage 1", chain: [] },
  ]
  const { gate } = setup()
  const task = rule(parent.id, {
    deferred,
    system: "children-done",
    match: { kinds: ["child_status_changed", "child_stage_changed"] },
    condition: { kind: "children-done" },
  })
  const moved = (from: string, to: string) =>
    event(activity(parent.id, { kind: "status_changed", from, to }))
  await expect(gate(task, moved("backlog", "todo"))).resolves.toEqual({
    fire: true,
    payload: { [WAKEUP_RELEASE_FLAG]: true },
  })
  await expect(gate(task, moved("todo", "in_review"))).resolves.toMatchObject({ fire: false })
})

it("fires an issue-finished rule only when the watched issue finished", async () => {
  const own = await makeIssue()
  const watched = await makeIssue({ status: "done" })
  const task = rule(own.id, {
    match: { kinds: ["status_changed"] },
    condition: { kind: "issue-finished", issueId: watched.id },
  })
  const { gate } = setup()
  const data = activity(watched.id, { kind: "status_changed", to: "done" })
  await expect(gate(task, event(data))).resolves.toEqual({ fire: true })
  await expect(gate(task, event({ ...data, to: "in_review" }))).resolves.toMatchObject({
    fire: false,
  })
})

it("fires a pr-merged rule only on a merge the issue's refs confirm", async () => {
  const { linkIssueExternal, recordIssuePullRequestState } = await import("@/lib/db/issues")
  const issue = await makeIssue()
  await linkIssueExternal(issue.id, { provider: "github-pr", externalId: "a/b#1" }, HUMAN)
  const task = rule(issue.id, {
    match: { kinds: ["pr_state_changed"] },
    condition: { kind: "pr-merged" },
  })
  const { gate } = setup()
  const merged = event(activity(issue.id, { kind: "pr_state_changed", prTo: "merged" }))
  // The event says merged but the ref does not (yet): no fire.
  await expect(gate(task, merged)).resolves.toMatchObject({ fire: false })
  await recordIssuePullRequestState(issue.id, "a/b#1", "merged", HUMAN)
  await expect(gate(task, merged)).resolves.toEqual({ fire: true })
  await expect(
    gate(task, event(activity(issue.id, { kind: "pr_state_changed", prTo: "closed" })))
  ).resolves.toMatchObject({ fire: false })
})

describe("an active run on the issue", () => {
  it("lets the fire through when the run has a session to steer", async () => {
    registerIssueRunAdapter(adapter(["s1"]))
    const issue = await makeIssue()
    await activeRun(issue.id)
    const { gate, held } = setup()
    await expect(gate(rule(issue.id), event(activity(issue.id)))).resolves.toEqual({ fire: true })
    expect(held).toEqual([])
  })

  it("holds the input instead of firing when the run cannot take it", async () => {
    registerIssueRunAdapter(adapter(null))
    const issue = await makeIssue()
    await activeRun(issue.id)
    const { gate, held } = setup()
    await expect(gate(rule(issue.id), event(activity(issue.id)))).resolves.toMatchObject({
      fire: false,
      reason: "held-for-active-run",
    })
    expect(held[0]).toHaveLength(1)
    expect(held[0]![0]).toMatchObject({ kind: "commented", subjectId: issue.id })
  })

  it("says in the held input which sub-issue hand-off it was", async () => {
    registerIssueRunAdapter(adapter(null))
    const parent = await makeIssue()
    const child = await makeIssue({ parentId: parent.id, status: "done" })
    await activeRun(parent.id)
    const { gate, held } = setup()
    const task = rule(parent.id, {
      match: { kinds: ["child_status_changed"] },
      condition: { kind: "children-done" },
    })
    const data = activity(parent.id, {
      kind: "child_status_changed",
      subjectId: child.id,
      from: "todo",
      to: "done",
      summary: "status todo → done",
    })
    await expect(gate(task, event(data))).resolves.toMatchObject({ reason: "held-for-active-run" })
    expect(held[0]![0]!.summary).toBe("status todo → done — All sub-issues are finished.")
  })
})

it("releases held inputs when the issue is accepted out of triage, not when it enters", async () => {
  const issue = await makeIssue()
  const deferred: IssueWakeupEvidence[] = [
    { kind: "commented", subjectId: issue.id, ts: 0, summary: "held", chain: [] },
  ]
  const { gate } = setup()
  const task = rule(issue.id, { deferred, match: { kinds: ["commented"] } })
  await expect(
    gate(task, event(activity(issue.id, { kind: "triage_changed", triageTo: null })))
  ).resolves.toEqual({ fire: true, payload: { [WAKEUP_RELEASE_FLAG]: true } })
  await expect(
    gate(task, event(activity(issue.id, { kind: "triage_changed", triageTo: "pending" })))
  ).resolves.toMatchObject({ fire: false })
})

it("releases held inputs when the blocking run settles, even its own", async () => {
  const issue = await makeIssue()
  const deferred: IssueWakeupEvidence[] = [
    { kind: "commented", subjectId: issue.id, ts: 0, summary: "held", chain: [] },
  ]
  const { gate } = setup()
  const settle = activity(issue.id, {
    kind: "run_succeeded",
    originTaskId: "wk1",
    actor: undefined,
  })
  await expect(gate(rule(issue.id, { deferred }), event(settle))).resolves.toEqual({
    fire: true,
    payload: { [WAKEUP_RELEASE_FLAG]: true },
  })
})
