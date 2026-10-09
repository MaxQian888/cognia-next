import type { ChatSession } from "@cognia/agent-config-types"
import type { AgentTask } from "@/types/agent/agent-task"
import type { Issue } from "@/types/issues"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import {
  ACTIVITY_WINDOW_MS,
  deriveAgentActivity,
  liveStatusOf,
  sessionActivityAt,
  summarizeAgents,
  type AgentRunStatus,
} from "./agent-activity"

const NOW = 1_000_000_000_000
const DAY = 24 * 60 * 60 * 1000

const session = (id: string, at: number, extra: Partial<ChatSession> = {}): ChatSession =>
  ({
    id,
    title: id,
    characterId: "agent",
    createdAt: at,
    updatedAt: at,
    lastMessageAt: at,
    ...extra,
  }) as ChatSession

const task = (id: string, status: AgentTask["status"], updatedAt: number): AgentTask => ({
  id,
  agentId: "agent",
  title: id,
  description: "",
  status,
  priority: "normal",
  dependencies: [],
  tags: [],
  order: 0,
  approvalPolicy: "on-risk",
  latestAttemptNo: 0,
  comments: [],
  createdAt: 0,
  updatedAt,
  revision: 1,
})

const issue = (id: string, completedAt?: number): Issue =>
  ({
    id,
    title: id,
    statusCategory: completedAt ? "completed" : "started",
    completedAt,
    updatedAt: completedAt ?? NOW - DAY,
  }) as Issue

const usage = (at: number, cost = 0.5): SessionUsageRow => ({
  messageId: `m-${at}`,
  sessionId: "s1",
  characterId: "agent",
  at,
  inputTokens: 100,
  outputTokens: 50,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  costUsd: cost,
  durationMs: 0,
})

describe("liveStatusOf", () => {
  it("lets a pending approval outrank a streaming run", () => {
    const status = new Map<string, AgentRunStatus>([
      ["a", "streaming"],
      ["b", "awaiting_approval"],
    ])
    expect(liveStatusOf(["a", "b"], status)).toBe("awaiting")
    expect(liveStatusOf(["a"], status)).toBe("running")
  })

  it("does not count an errored conversation as work in progress", () => {
    expect(liveStatusOf(["a"], new Map([["a", "error" as const]]))).toBe("idle")
  })

  it("counts an in-progress durable task as running", () => {
    expect(liveStatusOf([], new Map(), [{ status: "in_progress" }])).toBe("running")
    expect(liveStatusOf([], new Map(), [{ status: "pending" }])).toBe("idle")
  })
})

describe("sessionActivityAt", () => {
  it("prefers the last message over the last write", () => {
    expect(sessionActivityAt({ lastMessageAt: 5, updatedAt: 9 })).toBe(5)
    expect(sessionActivityAt({ updatedAt: 9 })).toBe(9)
  })
})

describe("deriveAgentActivity", () => {
  const sessions = [session("s1", NOW - DAY), session("s2", NOW - 40 * DAY)]
  const tasks = [
    task("t-run", "in_progress", NOW - 2 * DAY),
    task("t-done", "completed", NOW - 3 * DAY),
    task("t-old", "completed", NOW - 60 * DAY),
  ]
  const issues = [issue("i-done", NOW - 5 * DAY), issue("i-open")]

  it("separates what is running now from what finished", () => {
    const activity = deriveAgentActivity({
      sessions,
      tasks,
      issues,
      usage: [usage(NOW - DAY)],
      runStatus: new Map([["s1", "streaming"]]),
      now: NOW,
    })
    expect(activity.status).toBe("running")
    expect(
      activity.now.map((item) => (item.kind === "session" ? item.session.id : item.task.id))
    ).toEqual(["s1", "t-run"])
    // The live conversation is not also listed as recent work.
    expect(activity.recent.map((item) => item.kind)).not.toContain(undefined)
    expect(
      activity.recent.some((item) => item.kind === "session" && item.session.id === "s1")
    ).toBe(false)
    expect(activity.recent[0]).toMatchObject({ kind: "task", task: { id: "t-done" } })
  })

  it("lists unfinished tasks, newest first, whatever state short of finished they are in", () => {
    const activity = deriveAgentActivity({
      sessions: [],
      tasks: [
        task("t-pending", "pending", NOW - 5000),
        task("t-paused", "paused", NOW - 1000),
        task("t-blocked", "blocked", NOW - 3000),
        task("t-done", "completed", NOW),
        task("t-failed", "failed", NOW),
        task("t-cancelled", "cancelled", NOW),
      ],
      issues: [],
      usage: [],
      runStatus: new Map(),
      now: NOW,
    })
    expect(activity.openTasks.map((row) => row.id)).toEqual(["t-paused", "t-blocked", "t-pending"])
  })

  it("lists unfinished assigned issues, newest first, and leaves finished ones to the feed", () => {
    const canceled = { ...issue("i-canceled"), statusCategory: "canceled" } as Issue
    const newer = { ...issue("i-newer"), updatedAt: NOW - 1000 } as Issue
    const activity = deriveAgentActivity({
      sessions: [],
      tasks: [],
      issues: [...issues, canceled, newer],
      usage: [],
      runStatus: new Map(),
      now: NOW,
    })
    expect(activity.openIssues.map((row) => row.id)).toEqual(["i-newer", "i-open"])
    expect(activity.recent.map((item) => item.kind === "issue" && item.issue.id)).toEqual([
      "i-done",
    ])
  })

  it("counts only the window in its stats", () => {
    const activity = deriveAgentActivity({
      sessions,
      tasks,
      issues,
      usage: [usage(NOW - DAY, 0.25), usage(NOW - 2 * DAY, 0.5), usage(NOW - 31 * DAY, 9)],
      runStatus: new Map(),
      now: NOW,
    })
    expect(activity.stats).toEqual({
      conversations: 1,
      turns: 2,
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.75,
      completedTasks: 1,
      completedIssues: 1,
    })
    expect(activity.status).toBe("running")
    expect(activity.lastActiveAt).toBe(NOW - DAY)
  })

  it("has no last-active time for an agent that never ran", () => {
    const activity = deriveAgentActivity({
      sessions: [],
      tasks: [],
      issues: [],
      usage: [],
      runStatus: new Map(),
      now: NOW,
    })
    expect(activity.lastActiveAt).toBeUndefined()
    expect(activity.status).toBe("idle")
    expect(activity.recent).toEqual([])
  })

  it("keeps only the newest recent items", () => {
    const many = Array.from({ length: 15 }, (_, i) => session(`x${i}`, NOW - i * 1000))
    const activity = deriveAgentActivity({
      sessions: many,
      tasks: [],
      issues: [],
      usage: [],
      runStatus: new Map(),
      now: NOW,
      recentLimit: 3,
    })
    expect(activity.recent.map((item) => item.kind === "session" && item.session.id)).toEqual([
      "x0",
      "x1",
      "x2",
    ])
  })
})

describe("summarizeAgents", () => {
  it("summarises every agent from one read, including agents with no rows", () => {
    const summaries = summarizeAgents(
      ["agent", "other", "idle"],
      [
        { id: "s1", characterId: "agent", title: "", createdAt: 0, updatedAt: NOW - DAY },
        { id: "s2", characterId: "other", title: "", createdAt: 0, updatedAt: NOW - 50 * DAY },
      ],
      [
        { characterId: "agent", at: NOW - 2 * DAY },
        { characterId: "agent", at: NOW - ACTIVITY_WINDOW_MS - 1 },
      ],
      new Map([["s2", "awaiting_approval" as const]]),
      NOW
    )
    expect(summaries.get("agent")).toEqual({
      status: "idle",
      lastActiveAt: NOW - DAY,
      turns: 1,
      conversations: 1,
    })
    expect(summaries.get("other")).toMatchObject({ status: "awaiting", conversations: 0 })
    expect(summaries.get("idle")).toEqual({
      status: "idle",
      lastActiveAt: undefined,
      turns: 0,
      conversations: 0,
    })
  })
})
