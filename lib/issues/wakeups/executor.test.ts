/**
 * @jest-environment jsdom
 */

/**
 * The executor against a real tracker (Dexie fixture) and a stand-in run
 * engine. Scheduler writes are injected, so each case asserts exactly which
 * lifecycle call a fire made: pause and why, hold, consume, or none.
 */

jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: jest.fn(),
  registerTaskExecutor: jest.fn(),
  registerEventFireGate: jest.fn(),
}))

import type { IssueActor, IssueWakeupEvidence } from "@/types/issues"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue, getIssue } from "@/lib/db/issues"
import { createIssueRun, getIssueRun, listIssueRuns } from "@/lib/db/issue-runs"
import { listIssueEvents } from "@/lib/db/issue-events"
import {
  listIssueRunOptions,
  registerIssueRunAdapter,
  resetIssueRunRegistry,
  startIssueRun,
} from "@/lib/issues/run/registry"
import type { IssueRunAdapter, IssueRunStartContext } from "@/lib/issues/run/types"
import { registerEventFireGate, registerTaskExecutor } from "@/lib/scheduler/task-scheduler"
import {
  createIssueWakeupExecutor,
  registerIssueWakeupExecutor,
  resetIssueWakeupExecutorRegistration,
  type IssueWakeupExecutorDeps,
} from "./executor"
import { WAKEUP_BARRIER_KEY, WAKEUP_RELEASE_FLAG } from "./gate"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)
afterEach(resetIssueRunRegistry)

const HUMAN: IssueActor = { kind: "human" }
const AGENT: IssueActor = { kind: "agent", id: "char-1", label: "Ada" }
let containerId: string

beforeEach(async () => {
  containerId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
})

function makeIssue(over: Partial<Parameters<typeof createIssue>[0]> = {}) {
  return createIssue({
    projectId: "w1",
    issueProjectId: containerId,
    title: "x",
    createdBy: HUMAN,
    status: "todo",
    ...over,
  })
}

const starts: IssueRunStartContext[] = []

function engine(over: Partial<IssueRunAdapter> = {}): IssueRunAdapter {
  return {
    id: "fake",
    kind: "agent-task",
    canRun: async () => ({ ok: true }),
    start: async (target, context) => {
      starts.push(context)
      return createIssueRun({
        issueId: target.issue.id,
        projectId: target.issue.projectId,
        adapterId: "fake",
        kind: "agent-task",
        targetId: "task-1",
        by: context.by,
        ...(context.wakeup ? { wakeup: context.wakeup } : {}),
      })
    },
    poll: async () => null,
    ...over,
  }
}

function wakeupTask(
  issueId: string,
  over: Partial<ScheduledTask> = {},
  payload: Record<string, unknown> = {}
): ScheduledTask {
  return {
    id: "wk1",
    name: "wakeup",
    type: "issue-wakeup",
    trigger: { type: "event", eventType: "issue:activity", eventSource: `issue:${issueId}` },
    payload: { issueId, instruction: "Answer it.", author: AGENT, ...payload },
    config: {
      timeout: 60_000,
      maxRetries: 0,
      retryDelay: 0,
      runMissedOnStartup: false,
      maxRuns: 20,
    },
    notification: { onStart: false, onComplete: false, onError: true },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  }
}

/** The task as the scheduler hands it to the executor after an event fire. */
function fired(
  task: ScheduledTask,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): ScheduledTask {
  return {
    ...task,
    payload: {
      ...task.payload,
      event: { type: "issue:activity", source: task.trigger.eventSource, data },
      ...extra,
    },
  }
}

const EXECUTION = { id: "exec-1" } as TaskExecution
const SIGNAL = new AbortController().signal

function harness(task: ScheduledTask, over: Partial<IssueWakeupExecutorDeps> = {}) {
  const calls = {
    pause: [] as string[],
    deleted: [] as string[],
    consumed: [] as string[],
    deferred: [] as IssueWakeupEvidence[][],
  }
  const deps: Partial<IssueWakeupExecutorDeps> = {
    now: () => 10 * 3_600_000,
    loadTask: async () => task,
    priorEventFires: async () => [],
    deleteTask: async (id) => void calls.deleted.push(id),
    pause: async (_id, reason) => void calls.pause.push(reason),
    consume: async (id) => void calls.consumed.push(id),
    setDeferred: async (_id, deferred) => void calls.deferred.push([...deferred]),
    steer: async () => false,
    startRun: startIssueRun,
    listRunOptions: listIssueRunOptions,
    ...over,
  }
  return { execute: createIssueWakeupExecutor(deps), calls }
}

const comment = (issueId: string, over: Record<string, unknown> = {}) => ({
  issueId,
  subjectId: issueId,
  kind: "commented",
  ts: 1,
  actor: HUMAN,
  chain: [],
  summary: "comment: why?",
  ...over,
})

beforeEach(() => {
  starts.length = 0
})

describe("stopping the rule", () => {
  it("deletes a rule whose issue is gone", async () => {
    const task = wakeupTask("missing")
    const { execute, calls } = harness(task)
    const result = await execute(fired(task, comment("missing")), EXECUTION, SIGNAL)
    expect(calls.deleted).toEqual(["wk1"])
    expect(result).toMatchObject({ success: false, terminalReason: "wakeup-paused-issue-closed" })
  })

  it("pauses as issue-closed when the issue finished", async () => {
    const issue = await makeIssue({ status: "done" })
    const task = wakeupTask(issue.id)
    const { execute, calls } = harness(task)
    const result = await execute(fired(task, comment(issue.id)), EXECUTION, SIGNAL)
    expect(calls.pause).toEqual(["issue-closed"])
    expect(result.terminalReason).toBe("wakeup-paused-issue-closed")
  })

  it("pauses as loop when the chain already visited this rule twice", async () => {
    const issue = await makeIssue({ assignee: AGENT })
    const task = wakeupTask(issue.id)
    const { execute, calls } = harness(task)
    const result = await execute(
      fired(task, comment(issue.id, { chain: ["wk1", "wk2", "wk1"], actor: AGENT })),
      EXECUTION,
      SIGNAL
    )
    expect(calls.pause).toEqual(["loop"])
    expect(result.terminalReason).toBe("wakeup-paused-loop")
    expect(await listIssueRuns({ issueId: issue.id })).toHaveLength(0)
  })

  it("exempts the platform rule from loop detection", async () => {
    const issue = await makeIssue()
    const task = wakeupTask(issue.id, {}, { system: "children-done" })
    const { execute, calls } = harness(task)
    await execute(fired(task, comment(issue.id, { chain: ["wk1", "wk1"] })), EXECUTION, SIGNAL)
    expect(calls.pause).toEqual([])
  })

  it("pauses an event rule over its hourly cap, but not a release of held inputs", async () => {
    const issue = await makeIssue()
    const task = wakeupTask(issue.id)
    const busy = Array.from({ length: 12 }, () => new Date(10 * 3_600_000 - 1000))
    const { execute, calls } = harness(task, { priorEventFires: async () => busy })
    const result = await execute(fired(task, comment(issue.id)), EXECUTION, SIGNAL)
    expect(calls.pause).toEqual(["rate"])
    expect(result.terminalReason).toBe("wakeup-paused-rate")

    const released = harness(task, { priorEventFires: async () => busy })
    await released.execute(
      fired(task, comment(issue.id), { [WAKEUP_RELEASE_FLAG]: true }),
      EXECUTION,
      SIGNAL
    )
    expect(released.calls.pause).toEqual([])
  })
})

describe("delivering", () => {
  it("records a trail-only delivery when nobody is assigned", async () => {
    const issue = await makeIssue()
    const task = wakeupTask(issue.id)
    const { execute } = harness(task)
    const result = await execute(fired(task, comment(issue.id)), EXECUTION, SIGNAL)
    expect(result).toMatchObject({ success: true, output: { outcome: "trail", inputs: 1 } })
    const events = await listIssueEvents({ issueId: issue.id })
    expect(events.at(-1)?.payload).toMatchObject({
      kind: "wakeup_fired",
      delivery: "trail",
      taskId: "wk1",
    })
  })

  it("notifies a person assignee through the trail", async () => {
    const issue = await makeIssue({ assignee: HUMAN })
    const task = wakeupTask(issue.id)
    const { execute } = harness(task)
    await execute(fired(task, comment(issue.id)), EXECUTION, SIGNAL)
    const events = await listIssueEvents({ issueId: issue.id })
    expect(events.at(-1)?.payload).toMatchObject({ kind: "wakeup_fired", delivery: "notified" })
  })

  it("starts a run for an agent assignee, carrying the brief and the lineage onward", async () => {
    registerIssueRunAdapter(engine())
    const issue = await makeIssue({ assignee: AGENT })
    const task = wakeupTask(issue.id)
    const { execute } = harness(task)
    const result = await execute(
      fired(task, comment(issue.id, { chain: ["wk0"] })),
      EXECUTION,
      SIGNAL
    )
    expect(result).toMatchObject({ success: true, output: { outcome: "run", adapterId: "fake" } })
    expect(starts[0]?.origin).toBe("wakeup")
    expect(starts[0]?.brief).toContain("[WAKEUP wk1]")
    expect(starts[0]?.brief).toContain("comment: why?")
    expect(starts[0]?.wakeup).toEqual({
      taskId: "wk1",
      chain: ["wk0", "wk1"],
      statusBefore: "todo",
      periodic: false,
    })
    expect((await getIssue(issue.id))?.status).toBe("in_progress")
    const run = (await listIssueRuns({ issueId: issue.id }))[0]!
    expect(run.wakeup?.taskId).toBe("wk1")
  })

  it("consumes a one-shot rule and clears what it held once delivered", async () => {
    registerIssueRunAdapter(engine())
    const issue = await makeIssue({ assignee: AGENT })
    const held: IssueWakeupEvidence = {
      kind: "commented",
      subjectId: issue.id,
      ts: 0,
      summary: "earlier",
      chain: [],
    }
    const task = wakeupTask(issue.id, {}, { once: true, deferred: [held] })
    const { execute, calls } = harness(task)
    const result = await execute(fired(task, comment(issue.id)), EXECUTION, SIGNAL)
    expect(result.output).toMatchObject({ inputs: 2 })
    expect(calls.consumed).toEqual(["wk1"])
    expect(calls.deferred).toEqual([[]])
    expect(starts[0]?.brief).toContain("earlier")
  })

  it("steers the input into an active run and records the join", async () => {
    const issue = await makeIssue({ assignee: AGENT })
    const active = await createIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: "fake",
      kind: "agent-task",
      targetId: "t",
      by: HUMAN,
    })
    const task = wakeupTask(issue.id)
    const steered: string[] = []
    const { execute } = harness(task, {
      steer: async (_run, text) => {
        steered.push(text)
        return true
      },
    })
    const result = await execute(fired(task, comment(issue.id)), EXECUTION, SIGNAL)
    expect(result.output).toMatchObject({ outcome: "joined", runId: active.id })
    expect(steered[0]).toContain("joined this run")
    const events = await listIssueEvents({ issueId: issue.id })
    expect(events.at(-1)?.payload).toMatchObject({
      kind: "wakeup_fired",
      delivery: "joined",
      runId: active.id,
    })
  })

  it("holds the input when the active run cannot take it", async () => {
    const issue = await makeIssue({ assignee: AGENT })
    await createIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: "fake",
      kind: "agent-task",
      targetId: "t",
      by: HUMAN,
    })
    const task = wakeupTask(issue.id, {}, { once: true })
    const { execute, calls } = harness(task)
    const result = await execute(fired(task, comment(issue.id)), EXECUTION, SIGNAL)
    expect(result).toMatchObject({ success: true, terminalReason: "wakeup-deferred" })
    expect(calls.deferred[0]).toHaveLength(1)
    // Nothing was delivered, so a one-shot rule is not spent.
    expect(calls.consumed).toEqual([])
  })

  it("delivers only the held inputs on a release fire", async () => {
    registerIssueRunAdapter(engine())
    const issue = await makeIssue({ assignee: AGENT })
    const held: IssueWakeupEvidence = {
      kind: "commented",
      subjectId: issue.id,
      ts: 0,
      summary: "held one",
      chain: [],
    }
    const task = wakeupTask(issue.id, {}, { deferred: [held] })
    const { execute } = harness(task)
    const settle = {
      issueId: issue.id,
      subjectId: issue.id,
      kind: "run_succeeded",
      ts: 5,
      chain: [],
      summary: "run succeeded",
    }
    const result = await execute(
      fired(task, settle, { [WAKEUP_RELEASE_FLAG]: true }),
      EXECUTION,
      SIGNAL
    )
    expect(result.output).toMatchObject({ inputs: 1 })
    expect(starts[0]?.brief).toContain("held one")
    expect(starts[0]?.brief).not.toContain("run succeeded")
  })

  it("reports a refusal the engines gave, without retrying", async () => {
    registerIssueRunAdapter(engine({ canRun: async () => ({ ok: false, reason: "team-busy" }) }))
    const issue = await makeIssue({ assignee: AGENT })
    const task = wakeupTask(issue.id)
    const { execute } = harness(task)
    const result = await execute(fired(task, comment(issue.id)), EXECUTION, SIGNAL)
    expect(result).toMatchObject({ success: false, terminalReason: "wakeup-refused" })
    expect(result.error).toContain("fake: team-busy")
  })

  it("holds the input while the issue waits in triage, whichever engine the rule names", async () => {
    registerIssueRunAdapter(engine())
    const issue = await makeIssue({ assignee: AGENT, triage: "pending" })
    for (const payload of [{}, { adapterId: "fake" }]) {
      const task = wakeupTask(issue.id, {}, payload)
      const { execute, calls } = harness(task)
      const result = await execute(fired(task, comment(issue.id)), EXECUTION, SIGNAL)
      expect(result).toMatchObject({
        success: true,
        terminalReason: "wakeup-deferred",
        output: { outcome: "deferred", why: "issue-in-triage" },
      })
      expect(calls.deferred[0]).toHaveLength(1)
    }
    expect(starts).toHaveLength(0)
  })

  it("carries the sub-issue barrier a gate reached into the brief", async () => {
    registerIssueRunAdapter(engine())
    const issue = await makeIssue({ assignee: AGENT })
    const task = wakeupTask(issue.id, {}, { system: "children-done" })
    const { execute } = harness(task)
    await execute(
      fired(task, comment(issue.id), { [WAKEUP_BARRIER_KEY]: { kind: "stage", stage: 2 } }),
      EXECUTION,
      SIGNAL
    )
    expect(starts[0]!.brief).toContain("Sub-issue stage 2 and every earlier stage are finished.")
  })

  it("marks a periodic rule's run as periodic", async () => {
    registerIssueRunAdapter(engine())
    const issue = await makeIssue({ assignee: AGENT })
    const task = wakeupTask(issue.id, { trigger: { type: "interval", intervalMs: 3_600_000 } })
    const { execute } = harness(task)
    await execute(task, EXECUTION, SIGNAL)
    expect(starts[0]?.wakeup?.periodic).toBe(true)
    expect(starts[0]?.brief).toContain("issue_wakeup_checkin")
    const run = (await listIssueRuns({ issueId: issue.id }))[0]!
    expect((await getIssueRun(run.id))?.wakeup?.periodic).toBe(true)
  })

  it("refuses a task whose payload is not a wakeup", async () => {
    const task = { ...wakeupTask("i"), payload: { nope: true } }
    const { execute } = harness(task)
    await expect(execute(task, EXECUTION, SIGNAL)).resolves.toMatchObject({
      success: false,
      terminalReason: "wakeup-refused",
    })
  })
})

describe("registerIssueWakeupExecutor", () => {
  it("registers the executor and the fire gate once", () => {
    resetIssueWakeupExecutorRegistration()
    registerIssueWakeupExecutor()
    registerIssueWakeupExecutor()
    expect(registerTaskExecutor).toHaveBeenCalledTimes(1)
    expect(registerTaskExecutor).toHaveBeenCalledWith("issue-wakeup", expect.any(Function))
    expect(registerEventFireGate).toHaveBeenCalledWith("issue-wakeup", expect.any(Function))
  })
})
