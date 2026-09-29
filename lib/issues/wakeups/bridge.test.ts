import type { Issue, IssueActivityEventData, IssueEvent, IssueRun } from "@/types/issues"
import { emitIssueEvent } from "@/lib/issues/event-bus"
import {
  buildActivityData,
  installIssueWakeupBridge,
  relayIssueEvent,
  type IssueWakeupBridgeDeps,
} from "./bridge"

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: "c1",
    identifier: "MERC-2",
    number: 2,
    projectId: "w1",
    issueProjectId: "p1",
    title: "child",
    status: "done",
    statusCategory: "completed",
    priority: "none",
    createdBy: { kind: "human" },
    labelIds: [],
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function run(over: Partial<IssueRun> = {}): IssueRun {
  return {
    id: "r1",
    issueId: "c1",
    projectId: "w1",
    adapterId: "agent-task",
    kind: "agent-task",
    targetId: "task-1",
    status: "running",
    by: { kind: "human" },
    startedAt: 1,
    updatedAt: 1,
    artifacts: [],
    wakeup: { taskId: "wk1", chain: ["wk0", "wk1"], statusBefore: "todo", periodic: false },
    ...over,
  }
}

const statusEvent = (over: Partial<IssueEvent> = {}): IssueEvent => ({
  id: "e1",
  issueId: "c1",
  kind: "status_changed",
  ts: 10,
  payload: {
    kind: "status_changed",
    from: "in_review",
    to: "done",
    by: { kind: "agent", id: "task-1" },
  },
  ...over,
})

function deps(over: Partial<IssueWakeupBridgeDeps> = {}) {
  const published: Array<{ data: IssueActivityEventData; source: string }> = []
  const paused: string[] = []
  const ensured: string[] = []
  const all: IssueWakeupBridgeDeps = {
    listenedSources: async () => new Set(["issue:c1", "issue:parent"]),
    publish: async (data, source) => void published.push({ data, source }),
    getIssue: async () => issue({ parentId: "parent" }),
    listRuns: async () => [run()],
    pauseWakeupsForIssue: async (id) => void paused.push(id),
    ensureChildrenDoneWakeup: async (id) => void ensured.push(id),
    schedule: (fn) => fn(),
    onError: () => {},
    ...over,
  }
  return { deps: all, published, paused, ensured }
}

describe("buildActivityData", () => {
  it("forwards the lineage of the run that caused the entry", () => {
    const data = buildActivityData(statusEvent(), run())
    expect(data).toMatchObject({
      issueId: "c1",
      subjectId: "c1",
      kind: "status_changed",
      from: "in_review",
      to: "done",
      runId: "r1",
      originTaskId: "wk1",
      chain: ["wk0", "wk1"],
      summary: "status in_review → done",
    })
  })

  it("resets the chain when a person acted", () => {
    const human = statusEvent({
      payload: { kind: "status_changed", from: "todo", to: "done", by: { kind: "human" } },
    })
    expect(buildActivityData(human, run()).chain).toEqual([])
  })
})

describe("relayIssueEvent", () => {
  it("publishes on the issue's source and a child kind on the parent's", async () => {
    const harness = deps()
    await relayIssueEvent(statusEvent(), harness.deps)
    expect(harness.published.map((entry) => entry.source)).toEqual(["issue:c1", "issue:parent"])
    expect(harness.published[1]!.data).toMatchObject({
      issueId: "parent",
      subjectId: "c1",
      kind: "child_status_changed",
      to: "done",
      originTaskId: "wk1",
    })
  })

  it("re-publishes a child's stage move on the parent with the stage transition", async () => {
    const harness = deps({ getIssue: async () => issue({ parentId: "parent", status: "todo" }) })
    await relayIssueEvent(
      {
        id: "e5",
        issueId: "c1",
        kind: "stage_changed",
        ts: 3,
        payload: { kind: "stage_changed", to: 2, by: { kind: "human" } },
      },
      harness.deps
    )
    expect(harness.published.map((entry) => entry.data)).toEqual([
      expect.objectContaining({
        issueId: "c1",
        kind: "stage_changed",
        fromStage: null,
        toStage: 2,
      }),
      expect.objectContaining({
        issueId: "parent",
        subjectId: "c1",
        kind: "child_stage_changed",
        fromStage: null,
        toStage: 2,
      }),
    ])
    expect(harness.paused).toEqual([])
  })

  it("carries the triage transition", () => {
    const accepted = buildActivityData(
      {
        id: "e7",
        issueId: "c1",
        kind: "triage_changed",
        ts: 1,
        payload: { kind: "triage_changed", from: "pending", by: { kind: "human" } },
      },
      undefined
    )
    expect(accepted).toMatchObject({ kind: "triage_changed", triageTo: null })
    const merged = buildActivityData(
      {
        id: "e8",
        issueId: "c1",
        kind: "pr_state_changed",
        ts: 1,
        payload: {
          kind: "pr_state_changed",
          ref: { provider: "github-pr", externalId: "a/b#1" },
          from: "open",
          to: "merged",
          by: { kind: "agent", id: "sync:github" },
        },
      },
      undefined
    )
    expect(merged).toMatchObject({ prTo: "merged", summary: "pull request a/b#1 is merged" })
  })

  it("does not re-publish other child entries on the parent", async () => {
    const harness = deps()
    await relayIssueEvent(
      {
        id: "e6",
        issueId: "c1",
        kind: "commented",
        ts: 3,
        payload: { kind: "commented", commentId: "k", body: "hi", by: { kind: "human" } },
      },
      harness.deps
    )
    expect(harness.published.map((entry) => entry.source)).toEqual(["issue:c1"])
  })

  it("pauses the issue's own rules when it finishes", async () => {
    const harness = deps()
    await relayIssueEvent(statusEvent(), harness.deps)
    expect(harness.paused).toEqual(["c1"])
  })

  it("does nothing more when no rule listens on the issue or its parent", async () => {
    const harness = deps({ listenedSources: async () => new Set(["issue:elsewhere"]) })
    const listRuns = jest.fn(async () => [])
    await relayIssueEvent(statusEvent(), { ...harness.deps, listRuns })
    expect(harness.published).toEqual([])
    expect(listRuns).not.toHaveBeenCalled()
  })

  it("gives the parent its children-done rule when an issue gains one", async () => {
    const harness = deps({ getIssue: async () => issue({ parentId: undefined, status: "todo" }) })
    await relayIssueEvent(
      {
        id: "e2",
        issueId: "c1",
        kind: "parent_changed",
        ts: 1,
        payload: { kind: "parent_changed", to: "parent", by: { kind: "human" } },
      },
      harness.deps
    )
    expect(harness.ensured).toEqual(["parent"])
  })

  it("covers a child filed with its parent already set", async () => {
    const harness = deps()
    await relayIssueEvent(
      {
        id: "e3",
        issueId: "c1",
        kind: "created",
        ts: 1,
        payload: { kind: "created", by: { kind: "human" } },
      },
      harness.deps
    )
    expect(harness.ensured).toEqual(["parent"])
  })

  it("never publishes a delivery record", async () => {
    const harness = deps()
    await relayIssueEvent(
      {
        id: "e4",
        issueId: "c1",
        kind: "wakeup_fired",
        ts: 1,
        payload: {
          kind: "wakeup_fired",
          taskId: "wk1",
          delivery: "trail",
          instruction: "x",
          inputs: 1,
        },
      },
      harness.deps
    )
    expect(harness.published).toEqual([])
  })
})

describe("installIssueWakeupBridge", () => {
  it("relays bus events in order and stops after dispose", async () => {
    const harness = deps({ listenedSources: async () => new Set(["issue:c1"]) })
    const dispose = installIssueWakeupBridge({ deps: harness.deps })
    expect(installIssueWakeupBridge({ deps: harness.deps })).toBe(dispose)
    emitIssueEvent(statusEvent({ id: "a" }))
    emitIssueEvent(statusEvent({ id: "b" }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.published.map((entry) => entry.data.eventId)).toEqual(["a", "b"])
    dispose()
    emitIssueEvent(statusEvent({ id: "c" }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.published).toHaveLength(2)
  })

  it("reports a failing relay and keeps going", async () => {
    const errors: unknown[] = []
    let calls = 0
    const harness = deps({
      listenedSources: async () => {
        calls += 1
        if (calls === 1) throw new Error("boom")
        return new Set(["issue:c1"])
      },
      onError: (error) => errors.push(error),
    })
    const dispose = installIssueWakeupBridge({ deps: harness.deps })
    emitIssueEvent(statusEvent({ id: "a" }))
    emitIssueEvent(statusEvent({ id: "b" }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    dispose()
    expect(errors).toHaveLength(1)
    expect(harness.published.map((entry) => entry.data.eventId)).toEqual(["b"])
  })
})
