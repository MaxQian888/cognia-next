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
import {
  SELF_ACTOR_KEY,
  listRunningIssueIds,
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
