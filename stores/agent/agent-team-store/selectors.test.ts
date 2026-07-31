/**
 * @jest-environment jsdom
 */
import { useAgentTeamStore } from "./store"
import * as barrel from "./index"
import { initialState } from "./initial-state"
import {
  selectTeams,
  selectTeammates,
  selectTasks,
  selectMessages,
  selectActiveTeamId,
  selectSelectedTeammateId,
  selectDisplayMode,
  selectIsPanelOpen,
  selectWorkspaceTab,
  selectWorkspaceFocus,
  selectWorkspaceDetailOpen,
  selectTemplates,
  selectDefaultConfig,
  selectConsensus,
  selectSharedMemory,
  selectDelegations,
  selectEvents,
  selectTeamCount,
  selectActiveTeam,
  selectActiveTeamRoutingAssessment,
  selectActiveTeamSelectedExecutionPattern,
  selectActiveTeamExecutionReport,
  selectActiveTeamGovernanceSummary,
  selectActiveTeammates,
  selectActiveTeamTeammatesByStatus,
  selectActiveTeamIdleTeammates,
  selectActiveTeamExecutingTeammates,
  selectActiveTeamTasks,
  selectActiveTeamTasksByStatus,
  selectActiveTeamPendingTasks,
  selectActiveTeamBlockedTasks,
  selectActiveTeamCompletedTasks,
  selectActiveTeamInProgressTasks,
  selectActiveTeamTasksByAssignee,
  selectActiveTeamUnassignedTasks,
  selectActiveTeamMessages,
  selectActiveTeamUnreadMessages,
  selectTeamUnreadCount,
  selectTotalUnreadCount,
  selectActiveTeamMessagesByType,
  selectActiveTeamStructuredMessages,
  selectActiveTeamConsensus,
  selectActiveTeamPendingConsensus,
  selectActiveTeamSharedMemory,
  selectActiveTeamSharedMemoryEntries,
  selectActiveTeamDelegations,
  selectActiveDelegations,
  selectActiveTeamEvents,
  selectSharedMemoryEntriesForReader,
  isEntryReadableBy,
  OPERATOR_READER_ID,
} from "./selectors"
import type { AgentTeamState } from "./types"
import type { SharedMemoryEntry } from "@/types/agent/agent-team"

jest.mock("@cognia/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return {
    createLogger: () => ({ ...child, child: () => child }),
    logger: { ...child, child: () => child },
    loggers: {
      agent: { ...child, child: () => child },
      plugin: { ...child, child: () => child },
    },
  }
})

const baseState = (): AgentTeamState =>
  ({ ...initialState, templates: { ...initialState.templates } }) as unknown as AgentTeamState

describe("agent-team-store barrel", () => {
  it("re-exports useAgentTeamStore plus selectors", () => {
    expect(barrel.useAgentTeamStore).toBe(useAgentTeamStore)
    expect(typeof barrel.selectTeams).toBe("function")
    expect(typeof barrel.selectActiveTeam).toBe("function")
    expect(typeof barrel.selectTotalUnreadCount).toBe("function")
    expect(typeof barrel.selectActiveTeamGovernanceSummary).toBe("function")
  })
})

describe("agent-team-store base selectors against empty initial state", () => {
  const state = baseState()

  it("returns empty maps and defaults", () => {
    expect(selectTeams(state)).toEqual({})
    expect(selectTeammates(state)).toEqual({})
    expect(selectTasks(state)).toEqual({})
    expect(selectMessages(state)).toEqual({})
    expect(selectConsensus(state)).toEqual({})
    expect(selectSharedMemory(state)).toEqual({})
    expect(selectDelegations(state)).toEqual({})
    expect(selectEvents(state)).toEqual([])
    expect(selectActiveTeamId(state)).toBeNull()
    expect(selectSelectedTeammateId(state)).toBeNull()
    expect(selectDisplayMode(state)).toBe("expanded")
    expect(selectIsPanelOpen(state)).toBe(false)
    expect(selectWorkspaceTab(state)).toBe("overview")
    expect(selectWorkspaceFocus(state)).toEqual({
      teammateId: null,
      taskId: null,
      messageId: null,
    })
    expect(selectWorkspaceDetailOpen(state)).toBe(true)
    expect(selectDefaultConfig(state)).toBeDefined()
    // builtInTemplates seeded into templates
    expect(Object.keys(selectTemplates(state)).length).toBeGreaterThan(0)
  })
})

describe("agent-team-store derived selectors with no active team", () => {
  const state = baseState()

  it("returns empty/undefined collections", () => {
    expect(selectTeamCount(state)).toBe(0)
    expect(selectActiveTeam(state)).toBeUndefined()
    expect(selectActiveTeamRoutingAssessment(state)).toBeUndefined()
    expect(selectActiveTeamSelectedExecutionPattern(state)).toBeUndefined()
    expect(selectActiveTeamExecutionReport(state)).toBeUndefined()
    expect(selectActiveTeammates(state)).toEqual([])
    expect(selectActiveTeamIdleTeammates(state)).toEqual([])
    expect(selectActiveTeamExecutingTeammates(state)).toEqual([])
    expect(selectActiveTeamTeammatesByStatus("idle")(state)).toEqual([])
    expect(selectActiveTeamTasks(state)).toEqual([])
    expect(selectActiveTeamPendingTasks(state)).toEqual([])
    expect(selectActiveTeamBlockedTasks(state)).toEqual([])
    expect(selectActiveTeamCompletedTasks(state)).toEqual([])
    expect(selectActiveTeamInProgressTasks(state)).toEqual([])
    expect(selectActiveTeamTasksByStatus("pending")(state)).toEqual([])
    expect(selectActiveTeamTasksByAssignee("u-1")(state)).toEqual([])
    expect(selectActiveTeamUnassignedTasks(state)).toEqual([])
    expect(selectActiveTeamMessages(state)).toEqual([])
    expect(selectActiveTeamUnreadMessages(state)).toEqual([])
    expect(selectActiveTeamMessagesByType("direct")(state)).toEqual([])
    expect(selectActiveTeamStructuredMessages(state)).toEqual([])
    expect(selectActiveTeamConsensus(state)).toEqual([])
    expect(selectActiveTeamPendingConsensus(state)).toEqual([])
    expect(selectActiveTeamSharedMemory(state)).toEqual({})
    expect(selectActiveTeamSharedMemoryEntries(state)).toEqual([])
    expect(selectActiveTeamDelegations(state)).toEqual([])
    expect(selectActiveTeamEvents(state)).toEqual([])
  })

  it("selectTeamUnreadCount returns 0 for unknown teams and selectTotalUnreadCount returns 0 in empty state", () => {
    expect(selectTeamUnreadCount("missing")(state)).toBe(0)
    expect(selectTotalUnreadCount(state)).toBe(0)
  })

  it("selectActiveTeamGovernanceSummary returns a defaulted summary when no team is active", () => {
    const summary = selectActiveTeamGovernanceSummary(state)
    expect(summary.checkpointCount).toBe(0)
    expect(summary.approvalsRequested).toBe(0)
    expect(summary.delegatedTasks).toBe(0)
    expect(summary.blockedTasks).toBe(0)
    expect(summary.completedTasks).toBe(0)
    expect(summary.failedTasks).toBe(0)
    expect(summary.nextActions).toEqual([])
  })

  it("selectActiveDelegations returns empty when no delegations", () => {
    expect(selectActiveDelegations(state)).toEqual([])
  })
})

describe("agent-team-store derived selectors with populated state", () => {
  function buildPopulatedState(): AgentTeamState {
    const now = new Date()
    const lead = {
      id: "lead-1",
      teamId: "team-1",
      name: "Lead",
      description: "lead",
      role: "lead" as const,
      status: "idle" as const,
      config: {},
      completedTaskIds: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      progress: 0,
      createdAt: now,
    }
    const exec = {
      ...lead,
      id: "tm-1",
      role: "teammate" as const,
      status: "executing" as const,
    }
    const idle2 = { ...lead, id: "tm-2", role: "teammate" as const }
    const t1 = {
      id: "task-1",
      teamId: "team-1",
      title: "T1",
      description: "",
      status: "pending" as const,
      priority: "normal" as const,
      dependencies: [],
      tags: [],
      createdAt: now,
      order: 1,
    }
    const t2 = { ...t1, id: "task-2", status: "blocked" as const, order: 2 }
    const t3 = {
      ...t1,
      id: "task-3",
      status: "completed" as const,
      order: 3,
      assignedTo: "tm-1",
    }
    const t4 = { ...t1, id: "task-4", status: "in_progress" as const, order: 4, claimedBy: "tm-1" }
    const t5 = { ...t1, id: "task-5", order: 5, assignedTo: undefined } // unassigned pending
    const m1 = {
      id: "msg-1",
      teamId: "team-1",
      type: "direct" as const,
      senderId: "lead-1",
      senderName: "Lead",
      content: "hi",
      read: false,
      timestamp: new Date(now.getTime() + 1),
    }
    const m2 = {
      ...m1,
      id: "msg-2",
      type: "broadcast" as const,
      read: true,
      timestamp: new Date(now.getTime() + 2),
    }
    const m3 = {
      ...m1,
      id: "msg-3",
      timestamp: new Date(now.getTime() + 3),
      structuredPayload: { type: "idle_notification" as const },
    }
    const consensusOpen = {
      id: "c-1",
      teamId: "team-1",
      initiatorId: "lead-1",
      question: "?",
      options: ["a", "b"],
      type: "majority" as const,
      status: "open" as const,
      votes: [],
      createdAt: now,
    }
    const consensusResolved = { ...consensusOpen, id: "c-2", status: "resolved" as const }
    const sm = {
      key: "k",
      value: 1,
      writtenBy: "lead-1",
      writtenAt: now,
      version: 1,
    }
    const delegationActive = {
      id: "d-1",
      sourceTeamId: "team-1",
      sourceTaskId: "task-1",
      targetType: "team" as const,
      status: "active" as const,
      reason: "r",
      manual: false,
      createdAt: now,
      updatedAt: now,
    }
    const delegationDone = { ...delegationActive, id: "d-2", status: "completed" as const }
    const team = {
      id: "team-1",
      name: "T",
      description: "",
      task: "",
      status: "idle" as const,
      config: { ...initialState.defaultConfig },
      leadId: "lead-1",
      teammateIds: ["lead-1", "tm-1", "tm-2"],
      taskIds: ["task-1", "task-2", "task-3", "task-4", "task-5"],
      messageIds: ["msg-1", "msg-2", "msg-3"],
      progress: 0,
      totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      createdAt: now,
      consensusIds: ["c-1", "c-2"],
      routingAssessment: {
        recommendedPattern: "manager_worker" as const,
        confidence: 0.8,
        reason: "ok",
        factors: {
          taskComplexity: "moderate" as const,
          specializationNeeded: false,
          contextIsolationNeeded: false,
          delegationCandidate: false,
          budgetPressure: "low" as const,
        },
        createdAt: now,
      },
      selectedExecutionPattern: "parallel_specialists" as const,
      executionReport: {
        id: "r-1",
        teamId: "team-1",
        status: "running" as const,
        activeExecutionPattern: "manager_worker" as const,
        checkpoints: [
          {
            id: "ck-1",
            type: "task_completed" as const,
            timestamp: now,
            summary: "ok",
          },
        ],
        summary: {
          completedTasks: 1,
          failedTasks: 0,
          cancelledTasks: 0,
          blockedTasks: 1,
          delegatedTasks: 1,
          approvalsRequested: 1,
          retries: 0,
          totalTokens: 0,
          nextActions: ["next"],
        },
        traceSessionId: "trace-1",
        createdAt: now,
        updatedAt: now,
      },
    }

    const state: AgentTeamState = {
      ...initialState,
      teams: { "team-1": team },
      teammates: { "lead-1": lead, "tm-1": exec, "tm-2": idle2 },
      tasks: {
        "task-1": t1,
        "task-2": t2,
        "task-3": t3,
        "task-4": t4,
        "task-5": t5,
      },
      messages: { "msg-1": m1, "msg-2": m2, "msg-3": m3 },
      activeTeamId: "team-1",
      consensus: { "c-1": consensusOpen, "c-2": consensusResolved },
      sharedMemory: { "team-1": { mem: sm } },
      delegations: { "d-1": delegationActive, "d-2": delegationDone },
      events: [
        { type: "team_created", teamId: "team-1", timestamp: now },
        { type: "team_started", teamId: "other", timestamp: now },
      ],
    } as unknown as AgentTeamState
    return state
  }

  const state = buildPopulatedState()

  it("derives team-level selectors", () => {
    expect(selectTeamCount(state)).toBe(1)
    expect(selectActiveTeam(state)?.id).toBe("team-1")
    expect(selectActiveTeamRoutingAssessment(state)?.recommendedPattern).toBe("manager_worker")
    expect(selectActiveTeamSelectedExecutionPattern(state)).toBe("parallel_specialists")
    expect(selectActiveTeamExecutionReport(state)?.id).toBe("r-1")

    const summary = selectActiveTeamGovernanceSummary(state)
    expect(summary.recommendedPattern).toBe("manager_worker")
    expect(summary.activeExecutionPattern).toBe("manager_worker")
    expect(summary.selectedExecutionPattern).toBe("parallel_specialists")
    expect(summary.routingReason).toBe("ok")
    expect(summary.confidence).toBe(0.8)
    expect(summary.nextActions).toEqual(["next"])
    expect(summary.traceSessionId).toBe("trace-1")
    expect(summary.checkpointCount).toBe(1)
    expect(summary.approvalsRequested).toBe(1)
    expect(summary.delegatedTasks).toBe(1)
    expect(summary.blockedTasks).toBe(1)
    expect(summary.completedTasks).toBe(1)
    expect(summary.failedTasks).toBe(0)
  })

  it("derives teammate selectors", () => {
    expect(
      selectActiveTeammates(state)
        .map((t) => t.id)
        .sort()
    ).toEqual(["lead-1", "tm-1", "tm-2"])
    expect(
      selectActiveTeamIdleTeammates(state)
        .map((t) => t.id)
        .sort()
    ).toEqual(["lead-1", "tm-2"])
    expect(selectActiveTeamExecutingTeammates(state).map((t) => t.id)).toEqual(["tm-1"])
    expect(selectActiveTeamTeammatesByStatus("executing")(state).map((t) => t.id)).toEqual(["tm-1"])
  })

  it("derives task selectors", () => {
    expect(selectActiveTeamTasks(state).map((t) => t.id)).toEqual([
      "task-1",
      "task-2",
      "task-3",
      "task-4",
      "task-5",
    ])
    expect(selectActiveTeamTasksByStatus("pending")(state).map((t) => t.id)).toEqual([
      "task-1",
      "task-5",
    ])
    expect(selectActiveTeamPendingTasks(state).map((t) => t.id)).toEqual(["task-1", "task-5"])
    expect(selectActiveTeamBlockedTasks(state).map((t) => t.id)).toEqual(["task-2"])
    expect(selectActiveTeamCompletedTasks(state).map((t) => t.id)).toEqual(["task-3"])
    expect(selectActiveTeamInProgressTasks(state).map((t) => t.id)).toEqual(["task-4"])
    expect(
      selectActiveTeamTasksByAssignee("tm-1")(state)
        .map((t) => t.id)
        .sort()
    ).toEqual(["task-3", "task-4"])
    expect(selectActiveTeamUnassignedTasks(state).map((t) => t.id)).toEqual(["task-1", "task-5"])
  })

  it("derives message selectors and unread counts", () => {
    expect(selectActiveTeamMessages(state).map((m) => m.id)).toEqual(["msg-1", "msg-2", "msg-3"])
    expect(selectActiveTeamUnreadMessages(state).map((m) => m.id)).toEqual(["msg-1", "msg-3"])
    expect(selectActiveTeamMessagesByType("direct")(state).map((m) => m.id)).toEqual([
      "msg-1",
      "msg-3",
    ])
    expect(selectActiveTeamStructuredMessages(state).map((m) => m.id)).toEqual(["msg-3"])
    expect(selectTeamUnreadCount("team-1")(state)).toBe(2)
    expect(selectTotalUnreadCount(state)).toBe(2)
  })

  it("returns 0 from selectTeamUnreadCount when team has no messageIds or messages map empty", () => {
    const partial: AgentTeamState = {
      ...state,
      teams: {
        "team-2": { ...state.teams["team-1"], id: "team-2", messageIds: [] },
      },
    } as AgentTeamState
    expect(selectTeamUnreadCount("team-2")(partial)).toBe(0)
    // also exercise undefined messages map branch
    const noMessages = { ...partial, messages: undefined as unknown as AgentTeamState["messages"] }
    expect(selectTeamUnreadCount("team-2")(noMessages)).toBe(0)
  })

  it("selectTotalUnreadCount returns 0 when teams or messages map missing", () => {
    expect(
      selectTotalUnreadCount({
        ...state,
        teams: undefined as unknown as AgentTeamState["teams"],
      })
    ).toBe(0)
    expect(
      selectTotalUnreadCount({
        ...state,
        messages: undefined as unknown as AgentTeamState["messages"],
      })
    ).toBe(0)
  })

  it("selectTotalUnreadCount tolerates teams without messageIds", () => {
    const team2 = {
      ...state.teams["team-1"],
      id: "team-2",
      messageIds: undefined as unknown as string[],
    }
    const next: AgentTeamState = {
      ...state,
      teams: { ...state.teams, "team-2": team2 },
    }
    // Total unread still equals 2 because team-2 has no messages
    expect(selectTotalUnreadCount(next)).toBe(2)
  })

  it("derives consensus / shared memory / delegations / events selectors", () => {
    expect(
      selectActiveTeamConsensus(state)
        .map((c) => c.id)
        .sort()
    ).toEqual(["c-1", "c-2"])
    expect(selectActiveTeamPendingConsensus(state).map((c) => c.id)).toEqual(["c-1"])
    expect(Object.keys(selectActiveTeamSharedMemory(state))).toEqual(["mem"])
    expect(selectActiveTeamSharedMemoryEntries(state)).toHaveLength(1)
    expect(
      selectActiveTeamDelegations(state)
        .map((d) => d.id)
        .sort()
    ).toEqual(["d-1", "d-2"])
    expect(selectActiveDelegations(state).map((d) => d.id)).toEqual(["d-1"])
    expect(selectActiveTeamEvents(state).map((e) => e.type)).toEqual(["team_created"])
  })

  it("selectActiveTeamConsensus tolerates a team with no consensusIds", () => {
    const partial = {
      ...state,
      teams: {
        "team-1": { ...state.teams["team-1"], consensusIds: undefined },
      },
    } as unknown as AgentTeamState
    expect(selectActiveTeamConsensus(partial)).toEqual([])
  })

  it("selectActiveTeamGovernanceSummary falls back to executionReport.routingAssessment", () => {
    const stateWithoutTeamRouting: AgentTeamState = {
      ...state,
      teams: {
        "team-1": {
          ...state.teams["team-1"],
          routingAssessment: undefined,
          selectedExecutionPattern: undefined,
          executionReport: {
            ...state.teams["team-1"].executionReport!,
            routingAssessment: state.teams["team-1"].routingAssessment,
          },
        },
      },
    } as AgentTeamState
    const summary = selectActiveTeamGovernanceSummary(stateWithoutTeamRouting)
    expect(summary.recommendedPattern).toBe("manager_worker")
    expect(summary.routingReason).toBe("ok")
    expect(summary.confidence).toBe(0.8)
  })

  it("selectActiveTeamGovernanceSummary handles no executionReport at all", () => {
    const stateWithoutReport: AgentTeamState = {
      ...state,
      teams: {
        "team-1": {
          ...state.teams["team-1"],
          executionReport: undefined,
        },
      },
    } as AgentTeamState
    const summary = selectActiveTeamGovernanceSummary(stateWithoutReport)
    expect(summary.checkpointCount).toBe(0)
    expect(summary.nextActions).toEqual([])
  })
})

describe("shared-memory read ACL", () => {
  const mkEntry = (over: Partial<SharedMemoryEntry>): SharedMemoryEntry => ({
    key: over.key ?? "k",
    value: "v",
    writtenBy: over.writtenBy ?? "tm-writer",
    writtenAt: new Date(),
    version: 1,
    ...over,
  })

  it("isEntryReadableBy: empty/missing readableBy is all-can-read", () => {
    expect(isEntryReadableBy(mkEntry({}), "anyone")).toBe(true)
    expect(isEntryReadableBy(mkEntry({ readableBy: [] }), "anyone")).toBe(true)
  })

  it("isEntryReadableBy: allow-list gates non-listed readers", () => {
    const entry = mkEntry({ readableBy: ["tm-a"], writtenBy: "tm-writer" })
    expect(isEntryReadableBy(entry, "tm-a")).toBe(true)
    expect(isEntryReadableBy(entry, "tm-b")).toBe(false)
  })

  it("isEntryReadableBy: the writer always sees their own entry", () => {
    const entry = mkEntry({ readableBy: ["tm-a"], writtenBy: "tm-writer" })
    expect(isEntryReadableBy(entry, "tm-writer")).toBe(true)
  })

  it("isEntryReadableBy: the operator bypasses every allow-list", () => {
    const entry = mkEntry({ readableBy: ["tm-a"], writtenBy: "tm-writer" })
    expect(isEntryReadableBy(entry, OPERATOR_READER_ID)).toBe(true)
  })

  it("selectSharedMemoryEntriesForReader filters by ACL for a normal reader", () => {
    const state = {
      sharedMemory: {
        "team-1": {
          open: mkEntry({ key: "open" }),
          scoped: mkEntry({ key: "scoped", readableBy: ["tm-a"] }),
          mine: mkEntry({ key: "mine", readableBy: ["tm-a"], writtenBy: "tm-b" }),
        },
      },
    } as unknown as AgentTeamState

    const forB = selectSharedMemoryEntriesForReader(
      "team-1",
      "tm-b"
    )(state)
      .map((e) => e.key)
      .sort()
    expect(forB).toEqual(["mine", "open"])

    const forOperator = selectSharedMemoryEntriesForReader("team-1", OPERATOR_READER_ID)(state)
    expect(forOperator).toHaveLength(3)
  })

  it("selectSharedMemoryEntriesForReader returns [] for an unknown team", () => {
    const state = { sharedMemory: {} } as unknown as AgentTeamState
    expect(selectSharedMemoryEntriesForReader("nope", "tm-a")(state)).toEqual([])
  })
})

describe("agent-team-store initial-state shape", () => {
  it("exports a frozen-shape initialState ready for reset", () => {
    expect(initialState.teams).toEqual({})
    expect(initialState.teammates).toEqual({})
    expect(initialState.tasks).toEqual({})
    expect(initialState.messages).toEqual({})
    expect(initialState.events).toEqual([])
    expect(initialState.consensus).toEqual({})
    expect(initialState.sharedMemory).toEqual({})
    expect(initialState.delegations).toEqual({})
    expect(initialState.activeTeamId).toBeNull()
    expect(initialState.selectedTeammateId).toBeNull()
    expect(initialState.displayMode).toBe("expanded")
    expect(initialState.isPanelOpen).toBe(false)
    expect(initialState.workspaceTab).toBe("overview")
    expect(initialState.workspaceFocus).toEqual({
      teammateId: null,
      taskId: null,
      messageId: null,
    })
    expect(initialState.workspaceDetailOpen).toBe(true)
    expect(initialState.defaultConfig.executionMode).toBeDefined()
    expect(Object.keys(initialState.templates).length).toBeGreaterThan(0)
  })
})

describe("agent-team-store store-level config", () => {
  it("registers a localStorage persist key and partializes the right shape", () => {
    useAgentTeamStore.getState().reset()
    useAgentTeamStore.getState().setDisplayMode("compact")
    const stored = window.localStorage.getItem("cognia-agent-teams")
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored as string)
    expect(parsed.version).toBe(6)
    expect(parsed.state.displayMode).toBe("compact")
    // partialize keeps templates / defaultConfig / displayMode / workspaceTab /
    // lastAdapterSyncVersion AND (v4+) the durable team definitions.
    expect(parsed.state.workspaceTab).toBeDefined()
    expect(parsed.state.defaultConfig).toBeDefined()
    expect(parsed.state.lastAdapterSyncVersion).toBeDefined()
    // v4+ persists durable team maps (empty after reset, but present).
    expect(parsed.state.teams).toBeDefined()
    expect(parsed.state.tasks).toBeDefined()
    // v6 persists the project Editor session map.
    expect(parsed.state.editorSession).toBeDefined()
    // live runtime ephemera stays out of the persisted slice
    expect(parsed.state.messages).toBeUndefined()
  })

  it("identity-migrates persisted state across versions", async () => {
    // Seed an older-version snapshot directly into storage
    window.localStorage.setItem(
      "cognia-agent-teams",
      JSON.stringify({
        version: 0,
        state: {
          displayMode: "compact",
          workspaceTab: "tasks",
          defaultConfig: { ...initialState.defaultConfig, maxConcurrentTeammates: 7 },
          templates: {},
        },
      })
    )
    // Trigger a rehydrate so the migrate branch is exercised
    await useAgentTeamStore.persist.rehydrate()
    expect(useAgentTeamStore.getState().displayMode).toBe("compact")
  })
})
