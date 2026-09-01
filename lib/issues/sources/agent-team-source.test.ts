/**
 * @jest-environment jsdom
 */

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: {
    getState: () => ({
      teams: {
        "team-1": { id: "team-1", name: "Squad", status: "idle", projectId: "w1" },
        "team-2": { id: "team-2", name: "Other", status: "idle", projectId: "w2" },
      },
      tasks: {
        a: {
          id: "a",
          teamId: "team-1",
          title: "A",
          description: "",
          status: "pending",
          priority: "normal",
          dependencies: [],
          tags: [],
          createdAt: new Date(1),
          order: 0,
        },
        b: {
          id: "b",
          teamId: "team-2",
          title: "B",
          description: "",
          status: "pending",
          priority: "normal",
          dependencies: [],
          tags: [],
          createdAt: new Date(1),
          order: 0,
        },
      },
    }),
  },
}))
jest.mock("@/lib/db/issue-runs", () => ({ mapIssueRunsByTarget: async () => new Map() }))

import type { AgentTeam, AgentTeamTask } from "@/types/agent/agent-team"
import type { IssueRun } from "@/types/issues"
import { createIssueSourceRegistry } from "./registry"
import {
  AGENT_TEAM_SOURCE_LABEL,
  agentTeamIssueSource,
  createAgentTeamIssueSource,
  registerAgentTeamIssueSource,
  teamTaskIssueId,
  toUnifiedTeamTask,
} from "./agent-team-source"

function team(over: Partial<AgentTeam> = {}): AgentTeam {
  return { id: "team-1", name: "Squad", status: "executing", projectId: "w1", ...over } as AgentTeam
}

function task(over: Partial<AgentTeamTask> = {}): AgentTeamTask {
  return {
    id: "tt-1",
    teamId: "team-1",
    title: "Ship",
    description: "all",
    status: "review",
    priority: "critical",
    dependencies: [],
    tags: [],
    createdAt: new Date(100),
    startedAt: new Date(200),
    order: 1,
    ...over,
  }
}

function run(over: Partial<IssueRun> = {}): IssueRun {
  return {
    id: "run-1",
    issueId: "iss-1",
    projectId: "w1",
    adapterId: "agent-team",
    kind: "agent-team",
    targetId: "team-1",
    targetRef: { taskId: "tt-1" },
    status: "running",
    by: { kind: "human" },
    startedAt: 1,
    updatedAt: 1,
    artifacts: [],
    ...over,
  }
}

describe("toUnifiedTeamTask", () => {
  it("projects the task read-only with the team as assignee and Date fields to ms", () => {
    const item = toUnifiedTeamTask(task(), team())
    expect(item).toMatchObject({
      unifiedId: "agent-team:tt-1",
      kind: "agent-team",
      identifier: "Squad · #2",
      status: "in_review",
      statusCategory: "started",
      priority: "urgent",
      assignee: { kind: "team", id: "team-1", label: "Squad" },
      order: 1,
      createdAt: 100,
      updatedAt: 200,
      origin: {
        deepLinkHref: "/squads?id=team-1",
        sourceLabel: AGENT_TEAM_SOURCE_LABEL,
      },
    })
    expect(item.capabilities.canEdit).toBe(false)
    expect(
      toUnifiedTeamTask(task({ description: "", completedAt: 300 as never }), team()).updatedAt
    ).toBe(300)
    expect(toUnifiedTeamTask(task({ description: "" }), team()).description).toBeUndefined()
  })

  /**
   * Every mirrored row claimed the team, even when `AgentTeamTask.assignedTo`
   * named the teammate who had claimed it, so per-member attribution was
   * invisible on the board. The tracker's actor vocabulary already had
   * `"agent"` for exactly this.
   */
  it("names the teammate who claimed the task", () => {
    const item = toUnifiedTeamTask(
      task({ assignedTo: "m-7" }),
      team(),
      undefined,
      new Map([["m-7", "Reviewer"]])
    )
    expect(item.assignee).toEqual({ kind: "agent", id: "m-7", label: "Reviewer" })
  })

  it("falls back to the team when the claimant is not on the roster", () => {
    const item = toUnifiedTeamTask(task({ assignedTo: "ghost" }), team(), undefined, new Map())
    expect(item.assignee).toEqual({ kind: "team", id: "team-1", label: "Squad" })
  })

  /**
   * `labelIds: []` was hard-coded, so the filter bar's label facet silently
   * excluded this whole source. Tags are free text and labels are rows, so a
   * tag is only representable when a label of that name already exists.
   */
  it("resolves a tag to an existing label, case-insensitively", () => {
    const item = toUnifiedTeamTask(
      task({ tags: ["Backend", "unknown-tag"] }),
      team(),
      undefined,
      undefined,
      new Map([["backend", "label-be"]])
    )
    expect(item.labelIds).toEqual(["label-be"])
  })

  /** Read-only: a projection must never mint vocabulary the board then filters on. */
  it("never invents a label for an unmatched tag", () => {
    const item = toUnifiedTeamTask(
      task({ tags: ["brand-new"] }),
      team(),
      undefined,
      undefined,
      new Map()
    )
    expect(item.labelIds).toEqual([])
  })

  it("badges the originating issue", () => {
    const item = toUnifiedTeamTask(task(), team(), { identifier: "MERC-9", issueProjectId: "ip-9" })
    expect(item.origin.sourceLabel).toBe("Agent Team · MERC-9")
    expect(item.issueProjectId).toBe("ip-9")
  })

  it("reads metadata.issueId defensively", () => {
    expect(teamTaskIssueId(task())).toBeUndefined()
    expect(teamTaskIssueId(task({ metadata: { issueId: 3 } }))).toBeUndefined()
    expect(teamTaskIssueId(task({ metadata: { issueId: "" } }))).toBeUndefined()
    expect(teamTaskIssueId(task({ metadata: { issueId: "iss-1" } }))).toBe("iss-1")
  })
})

describe("list", () => {
  it("resolves origins from task metadata first, then from the run row", async () => {
    const source = createAgentTeamIssueSource({
      readTeams: async () => [
        {
          team: team(),
          tasks: [
            task({ id: "tt-meta", metadata: { issueId: "iss-meta" } }),
            task({ id: "tt-1" }), // origin via run row
            task({ id: "tt-none" }),
          ],
        },
      ],
      runsByTarget: async () => new Map([["team-1", run()]]),
      originRefsOf: async (ids) => {
        expect([...ids].sort()).toEqual(["iss-1", "iss-meta"])
        return new Map([
          ["iss-meta", { identifier: "MERC-5", issueProjectId: "ip-a" }],
          ["iss-1", { identifier: "MERC-6", issueProjectId: "ip-b" }],
        ])
      },
    })
    const items = await source.list({ projectId: "w1" })
    expect(items.map((i) => [i.sourceId, i.origin.sourceLabel, i.issueProjectId])).toEqual([
      ["tt-meta", "Agent Team · MERC-5", "ip-a"],
      ["tt-1", "Agent Team · MERC-6", "ip-b"],
      ["tt-none", "Agent Team", undefined],
    ])
    expect(
      (await source.list({ projectId: "w1", issueProjectId: "ip-b" })).map((i) => i.sourceId)
    ).toEqual(["tt-1"])
  })

  it("returns nothing for a workspace with no teams", async () => {
    const source = createAgentTeamIssueSource({
      readTeams: async () => [],
      runsByTarget: async () => {
        throw new Error("must not be called")
      },
    })
    expect(await source.list({ projectId: "w-empty" })).toEqual([])
  })

  it("reads teams and tasks for the workspace from the store by default", async () => {
    const items = await agentTeamIssueSource.list({ projectId: "w1" })
    expect(items.map((i) => i.sourceId)).toEqual(["a"])
    expect(items[0].assignee).toEqual({ kind: "team", id: "team-1", label: "Squad" })
    expect(await agentTeamIssueSource.list({ projectId: "w3" })).toEqual([])
  })

  it("registers into the source registry under its kind", () => {
    const registry = createIssueSourceRegistry()
    registerAgentTeamIssueSource(registry)
    expect(registry.getSource("agent-team")).toBe(agentTeamIssueSource)
  })
})
