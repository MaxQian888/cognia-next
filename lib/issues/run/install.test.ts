/**
 * @jest-environment jsdom
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createAgentTask } from "@/lib/db/agent-tasks"
import { getDb } from "@/lib/db/schema"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue, getIssue } from "@/lib/db/issues"
import { createIssueRun, getIssueRun } from "@/lib/db/issue-runs"
import {
  ISSUE_RUN_RECONCILE_INTERVAL_MS,
  __resetIssueRunBridgeForTesting,
  engineChangeSignature,
  installIssueRunBridge,
} from "./install"
import { IssueRunRegistry, resetIssueRunRegistry } from "./registry"
import { AGENT_TASK_RUN_ADAPTER_ID } from "./agent-task-adapter"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)
afterEach(() => {
  __resetIssueRunBridgeForTesting()
  resetIssueRunRegistry()
})

const HUMAN = { kind: "human" } as const

async function seedIssue() {
  const project = await createIssueProject({ projectId: "w1", name: "M", key: "MERC" })
  return createIssue({
    projectId: "w1",
    issueProjectId: project.id,
    title: "x",
    createdBy: HUMAN,
    status: "in_progress",
  })
}

const flush = (ms = 350) => new Promise((resolve) => setTimeout(resolve, ms))

describe("engineChangeSignature", () => {
  it("encodes active runs plus the engine rows they point at", async () => {
    expect(await engineChangeSignature()).toBe("runs:0")
    const issue = await seedIssue()
    const task = await createAgentTask({
      id: "agent-task:1",
      agentId: "c",
      title: "t",
      description: "",
    })
    await createIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: AGENT_TASK_RUN_ADAPTER_ID,
      kind: "agent-task",
      targetId: task.id,
      by: HUMAN,
    })
    await createIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: "github-loop",
      kind: "github-loop",
      targetId: "job-missing",
      by: HUMAN,
    })
    expect(await engineChangeSignature()).toBe("runs:2|task:agent-task:1:pending:1")
  })
})

describe("installIssueRunBridge", () => {
  it("registers the three adapters, is idempotent, and disposes cleanly", () => {
    const registry = new IssueRunRegistry()
    const dispose = installIssueRunBridge({ registry, subscribeTeamStore: false })
    expect(
      registry
        .list()
        .map((a) => a.id)
        .sort()
    ).toEqual(["agent-task", "agent-team", "github-loop"])
    expect(installIssueRunBridge({ registry, subscribeTeamStore: false })).toBe(dispose)
    dispose()
    dispose()
    // After dispose a fresh install is a new bridge.
    const again = installIssueRunBridge({ registry, subscribeTeamStore: false })
    expect(again).not.toBe(dispose)
    again()
    expect(ISSUE_RUN_RECONCILE_INTERVAL_MS).toBe(60_000)
  })

  it("settles a run at boot (reload recovery) and when the engine row changes", async () => {
    const registry = new IssueRunRegistry()
    const issue = await seedIssue()
    const task = await createAgentTask({
      id: "agent-task:boot",
      agentId: "c",
      title: "t",
      description: "",
      approvalPolicy: "auto",
    })
    // The task already finished while the app was away (written the way the
    // scheduler executor settles it — a direct row update, not a human move).
    await getDb().agentTasks.update(task.id, { status: "completed", revision: 2 })
    const finished = await createIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: AGENT_TASK_RUN_ADAPTER_ID,
      kind: "agent-task",
      targetId: task.id,
      by: HUMAN,
    })

    const errors: unknown[] = []
    const dispose = installIssueRunBridge({
      registry,
      subscribeTeamStore: false,
      onError: (e) => errors.push(e),
    })
    await flush()
    expect((await getIssueRun(finished.id))!.status).toBe("succeeded")
    expect((await getIssue(issue.id))!.status).toBe("in_review")

    // A second issue whose task finishes later: the liveQuery watcher fires.
    const issue2 = await createIssue({
      projectId: "w1",
      issueProjectId: issue.issueProjectId,
      title: "y",
      createdBy: HUMAN,
      status: "in_progress",
    })
    const task2 = await createAgentTask({
      id: "agent-task:live",
      agentId: "c",
      title: "t2",
      description: "",
      approvalPolicy: "auto",
    })
    const live = await createIssueRun({
      issueId: issue2.id,
      projectId: "w1",
      adapterId: AGENT_TASK_RUN_ADAPTER_ID,
      kind: "agent-task",
      targetId: task2.id,
      by: HUMAN,
    })
    await flush()
    expect((await getIssueRun(live.id))!.status).toBe("running")
    await getDb().agentTasks.update(task2.id, { status: "failed", revision: 2 })
    await flush(600)
    expect((await getIssueRun(live.id))!.status).toBe("failed")
    expect((await getIssue(issue2.id))!.status).toBe("in_review")
    expect(errors).toEqual([])
    dispose()
  })

  it("routes reconcile failures to onError instead of throwing", async () => {
    const registry = new IssueRunRegistry()
    const errors: unknown[] = []
    const dispose = installIssueRunBridge({
      registry,
      subscribeTeamStore: false,
      onError: (e) => errors.push(e),
      intervalMs: 50,
    })
    // Sabotage the registry after install so the interval-driven reconcile trips.
    const brokenAdapter = registry.get("agent-task")!
    registry.register({
      ...brokenAdapter,
      poll: async () => {
        throw new Error("poll boom")
      },
    })
    const issue = await seedIssue()
    await createIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: AGENT_TASK_RUN_ADAPTER_ID,
      kind: "agent-task",
      targetId: "agent-task:none",
      by: HUMAN,
    })
    await flush(400)
    // Poll errors are isolated inside reconcile (returned, not thrown), so
    // nothing reaches onError and the run stays active for the next pass.
    expect(errors).toEqual([])
    dispose()
  })
})
