/**
 * @jest-environment jsdom
 */

// The real store drags the whole agent-team runtime in and races the Dexie
// fixture; the default-deps path only needs `getState().teams`.
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: { getState: () => ({ teams: { "team-x": {}, "team-y": {} } }) },
}))

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createCharacter } from "@/lib/db/characters"
import { createIssueRun, settleIssueRun } from "@/lib/db/issue-runs"
import type { IssueRun } from "@/types/issues"
import {
  SELF_ACTOR_KEY,
  listRunningIssueIds,
  listSquadRunsByIssue,
  loadIssueViewerContext,
  viewerAgentKeys,
} from "./running"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("viewerAgentKeys", () => {
  it("returns every local Character and AgentTeam as an actor key, deduped and sorted", async () => {
    const keys = await viewerAgentKeys({
      listCharacterIds: async () => ["c2", "c1", "c1"],
      listTeamIds: async () => ["t1"],
    })
    expect(keys).toEqual(["agent:c1", "agent:c2", "team:t1"])
    const context = await loadIssueViewerContext({
      listCharacterIds: async () => [],
      listTeamIds: async () => [],
    })
    expect(context).toEqual({ selfKey: SELF_ACTOR_KEY, agentKeys: [] })
  })

  it("uses the Character table and the team store by default", async () => {
    const character = await createCharacter({ name: "Ada", systemPrompt: "hi" })
    const context = await loadIssueViewerContext()
    expect(context.selfKey).toBe("human:self")
    expect(context.agentKeys).toEqual(
      expect.arrayContaining([`agent:${character.id}`, "team:team-x", "team:team-y"])
    )
  })
})

describe("listRunningIssueIds", () => {
  it("mirrors the active-run index for the workspace", async () => {
    const run = await createIssueRun({
      issueId: "iss-a",
      projectId: "w1",
      adapterId: "x",
      kind: "agent-task",
      targetId: "t",
      by: { kind: "human" },
    })
    expect(await listRunningIssueIds("w1")).toEqual(new Set(["iss-a"]))
    await settleIssueRun(run.id, { status: "succeeded" })
    expect(await listRunningIssueIds("w1")).toEqual(new Set())
  })
})

describe("listSquadRunsByIssue", () => {
  const run = (over: Partial<IssueRun>): IssueRun => ({
    id: "r",
    issueId: "iss-a",
    projectId: "w1",
    adapterId: "agent-team",
    kind: "agent-team",
    targetId: "team-x",
    status: "running",
    by: { kind: "human" },
    startedAt: 1,
    updatedAt: 1,
    artifacts: [],
    ...over,
  })

  it("keeps the newest squad run per issue and resolves the team name", async () => {
    const refs = await listSquadRunsByIssue("w1", {
      listRuns: async () => [
        run({ id: "r2", startedAt: 2, status: "succeeded", targetId: "team-y" }),
        run({ id: "r1", startedAt: 1 }),
        run({ id: "r3", issueId: "iss-b", adapterId: "agent-task", kind: "agent-task" }),
      ],
      teamNameOf: async (teamId) => (teamId === "team-y" ? "Docs squad" : undefined),
    })
    expect([...refs.entries()]).toEqual([
      ["iss-a", { runId: "r2", teamId: "team-y", teamName: "Docs squad", status: "succeeded" }],
    ])
  })

  it("leaves the name off when the team no longer exists", async () => {
    const refs = await listSquadRunsByIssue("w1", {
      listRuns: async () => [run({})],
      teamNameOf: async () => undefined,
    })
    expect(refs.get("iss-a")).toEqual({ runId: "r", teamId: "team-x", status: "running" })
  })

  it("reads the workspace's run rows and the team store by default", async () => {
    await createIssueRun({
      issueId: "iss-z",
      projectId: "w1",
      adapterId: "agent-team",
      kind: "agent-team",
      targetId: "team-x",
      by: { kind: "human" },
    })
    const refs = await listSquadRunsByIssue("w1")
    expect(refs.get("iss-z")?.teamId).toBe("team-x")
  })
})
