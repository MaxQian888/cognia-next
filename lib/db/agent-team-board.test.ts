/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import {
  BOARD_COMMENTS_CAP,
  BOARD_PREVIEW_CAP,
  boardRowFromTask,
  boardRowFromTeam,
  deleteAgentTeamBoardRows,
  getAgentTeamBoardTeamRow,
  listAgentTeamBoardIds,
  listAgentTeamBoardRows,
  putAgentTeamBoardRows,
  teamMetaRowId,
} from "./agent-team-board"
import { getDb, __resetDbForTesting } from "./schema"
import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"

const task = (overrides: Partial<AgentTeamTask> = {}): AgentTeamTask =>
  ({
    id: "task-1",
    teamId: "team-a",
    title: "Ship",
    description: "d",
    status: "pending",
    priority: "high",
    dependencies: ["dep-1"],
    tags: ["ui"],
    createdAt: new Date(1000),
    order: 3,
    ...overrides,
  }) as AgentTeamTask

const team = (overrides: Partial<AgentTeam> = {}): AgentTeam =>
  ({
    id: "team-a",
    name: "Alpha",
    description: "",
    task: "t",
    status: "paused",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 3,
      executionMode: "coordinated",
      displayMode: "compact",
      knowledgeTwinIds: ["twin-7"],
    },
    leadId: "lead-1",
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(1000),
    ...overrides,
  }) as AgentTeam

const mate = (id: string, overrides: Partial<AgentTeammate> = {}): AgentTeammate =>
  ({
    id,
    teamId: "team-a",
    name: id,
    description: "",
    role: "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(1000),
    ...overrides,
  }) as AgentTeammate

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("boardRowFromTask", () => {
  it("serializes dates to epoch ms and copies board fields", () => {
    const row = boardRowFromTask(
      task({
        assignedTo: "w1",
        claimedBy: "w2",
        startedAt: new Date(2000),
        completedAt: new Date(3000),
        error: "boom",
        result: "done",
      }),
      5000
    )
    expect(row).toMatchObject({
      id: "task-1",
      kind: "task",
      teamId: "team-a",
      status: "pending",
      priority: "high",
      assignedTo: "w1",
      claimedBy: "w2",
      dependencies: ["dep-1"],
      tags: ["ui"],
      order: 3,
      createdAt: 1000,
      startedAt: 2000,
      completedAt: 3000,
      errorPreview: "boom",
      resultPreview: "done",
      updatedAt: 5000,
    })
  })

  it("caps the comment thread and truncates previews", () => {
    const comments = Array.from({ length: BOARD_COMMENTS_CAP + 5 }, (_, i) => ({
      id: `c${i}`,
      taskId: "task-1",
      authorId: "u",
      authorName: "U",
      text: "x".repeat(BOARD_PREVIEW_CAP + 100),
      createdAt: new Date(1000 + i),
    }))
    const row = boardRowFromTask(task({ comments, result: "y".repeat(9999) }), 5000)
    expect(row.commentCount).toBe(BOARD_COMMENTS_CAP + 5)
    expect(row.comments).toHaveLength(BOARD_COMMENTS_CAP)
    // Newest-last window: the first (oldest) comments were dropped.
    expect(row.comments[0].id).toBe("c5")
    expect(row.comments[0].text).toHaveLength(BOARD_PREVIEW_CAP)
    expect(row.resultPreview).toHaveLength(BOARD_PREVIEW_CAP)
  })
})

describe("boardRowFromTeam", () => {
  it("carries status, capacity, roster (with twin bindings) and knowledge twins", () => {
    const row = boardRowFromTeam(
      team(),
      [mate("w1", { config: { twinId: "twin-9" } }), mate("w2", { role: "lead" })],
      7000
    )
    expect(row).toEqual({
      id: teamMetaRowId("team-a"),
      kind: "team",
      teamId: "team-a",
      name: "Alpha",
      status: "paused",
      maxConcurrentTeammates: 3,
      teammates: [
        { id: "w1", name: "w1", role: "teammate", status: "idle", twinId: "twin-9" },
        { id: "w2", name: "w2", role: "lead", status: "idle" },
      ],
      knowledgeTwinIds: ["twin-7"],
      updatedAt: 7000,
    })
  })
})

describe("accessors", () => {
  it("round-trips rows and lists ids / per-team rows / the meta row", async () => {
    const taskRow = boardRowFromTask(task(), 100)
    const metaRow = boardRowFromTeam(team(), [mate("w1")], 100)
    const otherTeamTask = boardRowFromTask(task({ id: "task-9", teamId: "team-b" }), 100)
    await putAgentTeamBoardRows([taskRow, metaRow, otherTeamTask])

    expect((await listAgentTeamBoardIds()).sort()).toEqual(["task-1", "task-9", "team:team-a"])
    expect((await listAgentTeamBoardRows("team-a")).map((r) => r.id).sort()).toEqual([
      "task-1",
      "team:team-a",
    ])
    expect((await getAgentTeamBoardTeamRow("team-a"))?.name).toBe("Alpha")
    expect(await getAgentTeamBoardTeamRow("team-b")).toBeUndefined()

    await deleteAgentTeamBoardRows(["task-1"])
    expect(await getDb().agentTeamBoard.get("task-1")).toBeUndefined()
    // Empty batches are no-ops.
    await putAgentTeamBoardRows([])
    await deleteAgentTeamBoardRows([])
  })
})
