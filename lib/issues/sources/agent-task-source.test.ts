/**
 * @jest-environment jsdom
 */

import type { AgentTask } from "@/types/agent/agent-task"
import type { IssueRun } from "@/types/issues"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createAgentTask } from "@/lib/db/agent-tasks"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue } from "@/lib/db/issues"
import { createIssueRun } from "@/lib/db/issue-runs"
import { createIssueSourceRegistry } from "./registry"
import {
  AGENT_TASK_SOURCE_LABEL,
  agentSourceLabel,
  agentTaskIssueSource,
  createAgentTaskIssueSource,
  loadOriginIssueRefs,
  registerAgentTaskIssueSource,
  toUnifiedAgentTask,
} from "./agent-task-source"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function task(over: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "agent-task:abcdefghijk",
    agentId: "char-1",
    projectId: "w1",
    title: "Do it",
    description: "…",
    status: "in_progress",
    priority: "high",
    dependencies: [],
    tags: [],
    order: 3,
    approvalPolicy: "auto",
    latestAttemptNo: 1,
    comments: [],
    createdAt: 10,
    updatedAt: 20,
    revision: 1,
    ...over,
  }
}

function run(over: Partial<IssueRun> = {}): IssueRun {
  return {
    id: "run-1",
    issueId: "iss-1",
    projectId: "w1",
    adapterId: "agent-task",
    kind: "agent-task",
    targetId: "agent-task:abcdefghijk",
    status: "running",
    by: { kind: "human" },
    startedAt: 1,
    updatedAt: 1,
    artifacts: [],
    ...over,
  }
}

describe("toUnifiedAgentTask", () => {
  it("projects the task read-only with the agent as assignee", () => {
    const item = toUnifiedAgentTask(task())
    expect(item).toMatchObject({
      unifiedId: "agent-task:agent-task:abcdefghijk",
      kind: "agent-task",
      sourceId: "agent-task:abcdefghijk",
      identifier: "task abcdefgh",
      title: "Do it",
      description: "…",
      status: "in_progress",
      statusCategory: "started",
      priority: "high",
      assignee: { kind: "agent", id: "char-1" },
      labelIds: [],
      order: 3,
      createdAt: 10,
      updatedAt: 20,
      origin: {
        tableName: "agentTasks",
        deepLinkHref: "/settings?section=characters",
        sourceLabel: AGENT_TASK_SOURCE_LABEL,
      },
    })
    expect(item.capabilities.canMove).toBe(false)
    expect(item.issueProjectId).toBeUndefined()
    expect(item.createdBy).toBeUndefined()
    expect(toUnifiedAgentTask(task({ description: "" })).description).toBeUndefined()
  })

  it("inherits the originating issue's container and badges its identifier", () => {
    const item = toUnifiedAgentTask(task(), { identifier: "MERC-2", issueProjectId: "ip-1" })
    expect(item.issueProjectId).toBe("ip-1")
    expect(item.origin.sourceLabel).toBe("Agent Task · MERC-2")
    expect(agentSourceLabel("X", undefined)).toBe("X")
  })
})

describe("list", () => {
  it("returns every workspace task, badged when a run points at it", async () => {
    const source = createAgentTaskIssueSource({
      listTasks: async () => [task(), task({ id: "agent-task:other" })],
      runsByTarget: async () => new Map([["agent-task:abcdefghijk", run()]]),
      originRefsOf: async () =>
        new Map([["iss-1", { identifier: "MERC-2", issueProjectId: "ip-1" }]]),
    })
    const items = await source.list({ projectId: "w1" })
    expect(items.map((i) => [i.sourceId, i.origin.sourceLabel, i.issueProjectId])).toEqual([
      ["agent-task:abcdefghijk", "Agent Task · MERC-2", "ip-1"],
      ["agent-task:other", "Agent Task", undefined],
    ])
    // Container-scoped: only rows dispatched from that container's issues.
    expect(
      (await source.list({ projectId: "w1", issueProjectId: "ip-1" })).map((i) => i.sourceId)
    ).toEqual(["agent-task:abcdefghijk"])
    expect(await source.list({ projectId: "w1", issueProjectId: "ip-other" })).toEqual([])
  })

  it("wires the default deps end to end against Dexie", async () => {
    const project = await createIssueProject({ projectId: "w1", name: "M", key: "MERC" })
    const issue = await createIssue({
      projectId: "w1",
      issueProjectId: project.id,
      title: "t",
      createdBy: { kind: "human" },
    })
    const stored = await createAgentTask({
      id: "agent-task:real",
      agentId: "c",
      projectId: "w1",
      title: "real",
      description: "",
    })
    await createAgentTask({
      id: "agent-task:elsewhere",
      agentId: "c",
      projectId: "w2",
      title: "n",
      description: "",
    })
    await createIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: "agent-task",
      kind: "agent-task",
      targetId: stored.id,
      by: { kind: "human" },
    })
    const items = await agentTaskIssueSource.list({ projectId: "w1" })
    expect(items).toHaveLength(1)
    expect(items[0].origin.sourceLabel).toBe("Agent Task · MERC-1")
    expect(items[0].issueProjectId).toBe(project.id)
    expect(await loadOriginIssueRefs([])).toEqual(new Map())
    expect(await loadOriginIssueRefs([issue.id, "nope"])).toEqual(
      new Map([[issue.id, { identifier: "MERC-1", issueProjectId: project.id }]])
    )
  })

  it("registers into the source registry under its kind", () => {
    const registry = createIssueSourceRegistry()
    registerAgentTaskIssueSource(registry)
    expect(registry.getSource("agent-task")).toBe(agentTaskIssueSource)
  })
})
