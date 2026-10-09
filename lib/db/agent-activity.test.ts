/** @jest-environment jsdom */

import type { ChatSession } from "@cognia/agent-config-types"
import type { Issue } from "@/types/issues"
import {
  listAgentIssues,
  listAgentSessions,
  listAgentUsageSince,
  listAgentsSummaryInputs,
} from "./agent-activity"
import { getDb } from "./schema"
import type { SessionUsageRow } from "./session-usage"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture({ emptyTables: ["sessions", "issues", "sessionUsage"] })

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

function session(id: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return { id, title: id, createdAt: 1, updatedAt: 2, ...overrides } as ChatSession
}

function issue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    identifier: `ISS-${id}`,
    number: 1,
    projectId: "p1",
    issueProjectId: "ip1",
    title: id,
    status: "todo",
    statusCategory: "unstarted",
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as unknown as Issue
}

function usage(messageId: string, overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId,
    sessionId: "s1",
    at: 100,
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0.01,
    durationMs: 1,
    ...overrides,
  }
}

describe("listAgentSessions", () => {
  it("returns the agent's conversations, archived ones included", async () => {
    await getDb().sessions.bulkPut([
      session("a", { characterId: "agent-1" }),
      session("b", { characterId: "agent-1", archivedAt: 5 }),
      session("c", { characterId: "agent-2" }),
      session("d"),
    ])
    const rows = await listAgentSessions("agent-1")
    expect(rows.map((s) => s.id).sort()).toEqual(["a", "b"])
  })

  it("returns nothing for an agent with no conversations", async () => {
    await getDb().sessions.put(session("a", { characterId: "agent-1" }))
    expect(await listAgentSessions("nobody")).toEqual([])
  })
})

describe("listAgentIssues", () => {
  it("returns issues assigned to the agent only", async () => {
    await getDb().issues.bulkPut([
      issue("i1", { assigneeKind: "agent", assigneeId: "agent-1" }),
      issue("i2", { assigneeKind: "agent", assigneeId: "agent-2" }),
      // A human with the same id is not the agent.
      issue("i3", { assigneeKind: "human", assigneeId: "agent-1" }),
      issue("i4"),
    ])
    expect((await listAgentIssues("agent-1")).map((i) => i.id)).toEqual(["i1"])
  })
})

describe("listAgentUsageSince", () => {
  it("returns the agent's spend rows at or after the cutoff", async () => {
    await getDb().sessionUsage.bulkPut([
      usage("m1", { characterId: "agent-1", at: 99 }),
      usage("m2", { characterId: "agent-1", at: 100 }),
      usage("m3", { characterId: "agent-1", at: 150 }),
      usage("m4", { characterId: "agent-2", at: 200 }),
      usage("m5", { at: 200 }),
    ])
    const rows = await listAgentUsageSince("agent-1", 100)
    expect(rows.map((r) => r.messageId).sort()).toEqual(["m2", "m3"])
  })
})

describe("listAgentsSummaryInputs", () => {
  it("reads every agent-bound session and every attributed spend row since the cutoff", async () => {
    await getDb().sessions.bulkPut([
      session("a", {
        characterId: "agent-1",
        title: "Alpha",
        createdAt: 10,
        updatedAt: 20,
        lastMessageAt: 15,
        archivedAt: 30,
        projectId: "p1",
      }),
      session("b", { characterId: "agent-2", title: "Beta", createdAt: 1, updatedAt: 2 }),
      session("unbound", { title: "Plain chat" }),
    ])
    await getDb().sessionUsage.bulkPut([
      usage("m1", { characterId: "agent-1", at: 500, sessionId: "a", costUsd: 1 }),
      usage("m2", { characterId: "agent-1", at: 10, sessionId: "a" }),
      usage("m3", { at: 600, sessionId: "unbound" }),
      usage("m4", { characterId: "", at: 700, sessionId: "unbound" }),
    ])

    const inputs = await listAgentsSummaryInputs(100)

    expect([...inputs.sessions].sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      {
        id: "a",
        characterId: "agent-1",
        title: "Alpha",
        createdAt: 10,
        updatedAt: 20,
        lastMessageAt: 15,
        archivedAt: 30,
      },
      {
        id: "b",
        characterId: "agent-2",
        title: "Beta",
        createdAt: 1,
        updatedAt: 2,
        lastMessageAt: undefined,
        archivedAt: undefined,
      },
    ])
    expect(inputs.usage).toEqual([{ characterId: "agent-1", at: 500, sessionId: "a" }])
  })

  it("returns empty lists when nothing is agent-bound", async () => {
    await getDb().sessions.put(session("plain"))
    expect(await listAgentsSummaryInputs(0)).toEqual({ sessions: [], usage: [] })
  })
})
