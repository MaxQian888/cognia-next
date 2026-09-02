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
  selectTemplates,
  selectDefaultConfig,
  selectConsensus,
  selectSharedMemory,
  selectDelegations,
  selectEvents,
  selectTeamTeammates,
  selectActiveTeamConsensus,
  selectTeamConsensus,
  selectActiveTeamDelegations,
  selectTeamDelegations,
  selectActiveDelegations,
  selectSharedMemoryEntriesForReader,
  isEntryReadableBy,
  OPERATOR_READER_ID,
} from "./selectors"
import type { AgentTeamState } from "./types"
import type { SharedMemoryEntry } from "@/types/agent/agent-team"

jest.mock("@cognia/logging", () => {
  // Namespace-agnostic on purpose. These mocks used to list the handful of
  // `loggers.*` names the suite happened to reach, so the day an import chain
  // grew a new one the whole suite died at load with
  // "Cannot read properties of undefined (reading 'child')" and zero tests ran.
  // A Proxy answers for any namespace, so graph growth cannot go dark here.
  const child: Record<string, unknown> = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    trace: jest.fn(),
  }
  child.child = () => child
  return {
    createLogger: () => child,
    logger: child,
    loggers: new Proxy({} as Record<string, unknown>, { get: () => child }),
  }
})

const baseState = (): AgentTeamState =>
  ({ ...initialState, templates: { ...initialState.templates } }) as unknown as AgentTeamState

describe("agent-team-store barrel", () => {
  it("re-exports useAgentTeamStore plus selectors", () => {
    expect(barrel.useAgentTeamStore).toBe(useAgentTeamStore)
    expect(typeof barrel.selectTeams).toBe("function")
    expect(typeof barrel.selectTeamTeammates).toBe("function")
    expect(typeof barrel.selectTeamConsensus).toBe("function")
    expect(typeof barrel.selectTeamDelegations).toBe("function")
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
    expect(selectDefaultConfig(state)).toBeDefined()
    // builtInTemplates seeded into templates
    expect(Object.keys(selectTemplates(state)).length).toBeGreaterThan(0)
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

  it("selectTeamTeammates returns the named team's roster in roster order", () => {
    expect(selectTeamTeammates(state, "team-1").map((t) => t.id)).toEqual([
      "lead-1",
      "tm-1",
      "tm-2",
    ])
    // Unknown and absent team ids are the same answer: nothing, not a throw.
    expect(selectTeamTeammates(state, "team-missing")).toEqual([])
    expect(selectTeamTeammates(state, undefined)).toEqual([])
  })

  it("derives consensus and delegations for a NAMED team", () => {
    expect(
      selectTeamConsensus(state, "team-1")
        .map((c) => c.id)
        .sort()
    ).toEqual(["c-1", "c-2"])
    expect(selectTeamConsensus(state, "team-missing")).toEqual([])
    expect(
      selectTeamDelegations(state, "team-1")
        .map((d) => d.id)
        .sort()
    ).toEqual(["d-1", "d-2"])
    expect(selectActiveDelegations(state).map((d) => d.id)).toEqual(["d-1"])
  })

  it("the activeTeamId fallbacks still resolve the last-created team", () => {
    expect(
      selectActiveTeamConsensus(state)
        .map((c) => c.id)
        .sort()
    ).toEqual(["c-1", "c-2"])
    expect(
      selectActiveTeamDelegations(state)
        .map((d) => d.id)
        .sort()
    ).toEqual(["d-1", "d-2"])
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
    // `displayMode` / `workspaceTab` are intentionally inert: persisted so an
    // older build's blob round-trips, read and written by nothing. See the
    // notes on their declarations in `types.ts`.
    expect(initialState.displayMode).toBe("expanded")
    expect(initialState.workspaceTab).toBe("overview")
    expect("selectedTeammateId" in initialState).toBe(false)
    expect("isPanelOpen" in initialState).toBe(false)
    expect("workspaceFocus" in initialState).toBe(false)
    expect("workspaceDetailOpen" in initialState).toBe(false)
    expect(initialState.defaultConfig.executionMode).toBeDefined()
    expect(Object.keys(initialState.templates).length).toBeGreaterThan(0)
  })
})

describe("agent-team-store store-level config", () => {
  it("registers a localStorage persist key and partializes the right shape", () => {
    useAgentTeamStore.getState().reset()
    // `setDisplayMode` went with the retired workspace shell. The field is
    // still persisted so an older blob round-trips, which is what this asserts.
    useAgentTeamStore.setState({ displayMode: "compact" })
    const stored = window.localStorage.getItem("cognia-agent-teams")
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored as string)
    // Tracks `PERSIST_VERSION`. This said 6 for as long as the suite could not
    // load, which is what a dark test costs: the bump to 7 landed with nothing
    // watching.
    expect(parsed.version).toBe(8)
    expect(parsed.state.displayMode).toBe("compact")
    // partialize keeps templates / defaultConfig / displayMode / workspaceTab /
    // lastAdapterSyncVersion. Squad templates stay here because they are
    // profile-shared by design.
    expect(parsed.state.workspaceTab).toBeDefined()
    expect(parsed.state.defaultConfig).toBeDefined()
    expect(parsed.state.lastAdapterSyncVersion).toBeDefined()
    // v8 hands the durable definitions to Dexie (`dexie-bridge.ts`). A second
    // copy here would be a durable store with no rule for which one wins, and
    // this one can be neither workspace-scoped nor synced to a paired device.
    expect(parsed.state.teams).toBeUndefined()
    expect(parsed.state.teammates).toBeUndefined()
    expect(parsed.state.tasks).toBeUndefined()
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
