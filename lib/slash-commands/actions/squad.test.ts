// `/squad` command family, the keyboard reach a Squad did not have.
//
// The store and the project store are mocked as plain state readers, matching
// `plan.test.ts`, so a case can pose an exact fleet without booting Dexie.
// `startSquadRun` and `agentTeamManager` are mocked because asserting WHICH
// funnel a branch takes is most of the point: a `/squad run` that reached
// `agentTeamManager.start` directly would skip the run-id convention and the
// execution row, and the test would still look green.

jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/stores/agent/agent-team-store", () => ({ useAgentTeamStore: { getState: jest.fn() } }))
jest.mock("@/stores/project/project-store", () => ({ useProjectStore: { getState: jest.fn() } }))

const startSquadRun = jest.fn()
jest.mock("@/lib/ai/agent/team/start-squad-run", () => ({
  startSquadRun: (...a: unknown[]) => startSquadRun(...(a as [])),
}))

const managerPause = jest.fn()
const managerResume = jest.fn()
const managerShutdown = jest.fn()
jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: {
    pause: (...a: unknown[]) => managerPause(...(a as [])),
    resume: (...a: unknown[]) => managerResume(...(a as [])),
    shutdown: (...a: unknown[]) => managerShutdown(...(a as [])),
  },
}))

import { getSession } from "@/lib/db/sessions"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useProjectStore } from "@/stores/project/project-store"
import { soloTeamId } from "@/lib/agent/plan-mode-bridge"
import { dispatchSquadSubcommand } from "./squad"
import type { SlashContext } from "../builtin"
import type { AgentTeam, AgentTeamTask, AgentTeammate } from "@/types/agent/agent-team"

const getSessionMock = getSession as jest.Mock
const teamStateMock = useAgentTeamStore.getState as jest.Mock
const projectStateMock = useProjectStore.getState as jest.Mock

const SESSION = "sess_1"

function squad(over: Partial<AgentTeam> = {}): AgentTeam {
  return {
    id: "team_1",
    name: "Review Crew",
    description: "",
    task: "review the diff",
    status: "idle",
    config: { runtimeVersion: "durable-v2" },
    leadId: "mate_lead",
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: 0,
    createdAt: new Date(),
    ...over,
  } as unknown as AgentTeam
}

function seed(
  teams: AgentTeam[],
  opts: {
    teammates?: Partial<AgentTeammate>[]
    tasks?: Partial<AgentTeamTask>[]
    activeProjectId?: string | null
  } = {}
) {
  teamStateMock.mockReturnValue({
    teams: Object.fromEntries(teams.map((t) => [t.id, t])),
    teammates: Object.fromEntries((opts.teammates ?? []).map((m, i) => [m.id ?? `m${i}`, m])),
    tasks: Object.fromEntries((opts.tasks ?? []).map((t, i) => [t.id ?? `t${i}`, t])),
  })
  projectStateMock.mockReturnValue({ activeProjectId: opts.activeProjectId ?? null })
}

function ctx(args: string, over: Partial<SlashContext> = {}): SlashContext {
  return {
    args,
    activeSessionId: SESSION,
    chatStatus: "ready",
    currentPermissionMode: null,
    startNewSession: jest.fn(),
    openSettings: jest.fn(),
    setPermissionMode: jest.fn(),
    pushSystemMessage: jest.fn(),
    ...over,
  } as unknown as SlashContext
}

beforeEach(() => {
  jest.clearAllMocks()
  getSessionMock.mockResolvedValue({ id: SESSION, squadId: "team_1" })
  startSquadRun.mockResolvedValue({ started: true, runId: "run_1", squadName: "Review Crew" })
  seed([squad()])
})

describe("guards", () => {
  it("refuses without an active session", async () => {
    const result = await dispatchSquadSubcommand(ctx("list", { activeSessionId: null }))
    expect(result.system).toMatch(/Start a chat session first/)
  })

  it("refuses mid-stream, so it cannot race the in-session driver", async () => {
    const result = await dispatchSquadSubcommand(ctx("run", { chatStatus: "streaming" }))
    expect(result.system).toMatch(/still streaming/)
    expect(startSquadRun).not.toHaveBeenCalled()
  })
})

describe("resolution", () => {
  it("bare /squad answers for the session's bound Squad", async () => {
    const result = await dispatchSquadSubcommand(ctx(""))
    expect(result.system).toContain("Review Crew")
  })

  it("falls back to teamId when no squadId is bound", async () => {
    getSessionMock.mockResolvedValue({ id: SESSION, teamId: "team_1" })
    const result = await dispatchSquadSubcommand(ctx("status"))
    expect(result.system).toContain("Review Crew")
  })

  /**
   * The plan-mode bridge fills `solo:<sessionId>` from TodoWrite tool calls.
   * Answering for it would report on a Squad the user never created.
   */
  it("never resolves the synthetic solo team as a Squad", async () => {
    const solo = soloTeamId(SESSION)
    getSessionMock.mockResolvedValue({ id: SESSION, teamId: solo })
    seed([squad({ id: solo, name: "Solo" })])
    const result = await dispatchSquadSubcommand(ctx("status"))
    expect(result.system).toMatch(/not handed to a Squad/)
  })

  it("resolves an explicit name, and reports an ambiguous one instead of guessing", async () => {
    seed([squad(), squad({ id: "team_2", name: "Review Crew (web)" })])
    getSessionMock.mockResolvedValue({ id: SESSION })
    const one = await dispatchSquadSubcommand(ctx("status Review Crew (web)"))
    expect(one.system).toContain("Review Crew (web)")
    const many = await dispatchSquadSubcommand(ctx("status Review"))
    expect(many.system).toMatch(/matches 2 Squads/)
  })

  it("reports an unmatched name rather than acting on the bound Squad", async () => {
    const result = await dispatchSquadSubcommand(ctx("status Ghost Crew"))
    expect(result.system).toMatch(/No Squad matches "Ghost Crew"/)
  })
})

describe("list", () => {
  it("scopes to the workspace, treating an unowned Squad as shared", async () => {
    seed(
      [
        squad({ id: "a", name: "Mine", projectId: "p1" }),
        squad({ id: "b", name: "Theirs", projectId: "p2" }),
        squad({ id: "c", name: "Shared" }),
      ],
      { activeProjectId: "p1" }
    )
    const result = await dispatchSquadSubcommand(ctx("list"))
    expect(result.system).toContain("Mine")
    expect(result.system).toContain("Shared")
    expect(result.system).not.toContain("Theirs")
    expect(result.system).toContain("(2)")
  })

  it("puts live Squads above idle ones, matching the fleet rail", async () => {
    seed([
      squad({ id: "a", name: "Aardvark" }),
      squad({ id: "z", name: "Zebra", status: "executing" }),
    ])
    const result = await dispatchSquadSubcommand(ctx("list"))
    expect(result.system.indexOf("Zebra")).toBeLessThan(result.system.indexOf("Aardvark"))
  })

  it("says the workspace is empty rather than printing a bare heading", async () => {
    seed([])
    const result = await dispatchSquadSubcommand(ctx("list"))
    expect(result.system).toMatch(/No Squads in this workspace/)
  })
})

describe("run", () => {
  it("goes through the ADR-0140 funnel and carries the session", async () => {
    const result = await dispatchSquadSubcommand(ctx("run ship the release"))
    expect(startSquadRun).toHaveBeenCalledWith(
      expect.objectContaining({
        squadId: "team_1",
        goal: "ship the release",
        origin: "chat",
        session: expect.objectContaining({ id: SESSION }),
      })
    )
    expect(result.system).toContain("is running")
  })

  it("starts a named Squad when the session has no binding, without eating the name as a goal", async () => {
    getSessionMock.mockResolvedValue({ id: SESSION })
    await dispatchSquadSubcommand(ctx("run Review Crew"))
    expect(startSquadRun).toHaveBeenCalledWith(
      expect.objectContaining({ squadId: "team_1", goal: "" })
    )
  })

  it("refuses a Squad that is already busy instead of double-starting it", async () => {
    seed([squad({ status: "executing" })])
    const result = await dispatchSquadSubcommand(ctx("run"))
    expect(result.system).toMatch(/already executing/)
    expect(startSquadRun).not.toHaveBeenCalled()
  })

  it("reports a dispatch refusal", async () => {
    startSquadRun.mockResolvedValue({ started: false, reason: "squad_not_found" })
    const result = await dispatchSquadSubcommand(ctx("run"))
    expect(result.system).toMatch(/Could not start.*squad_not_found/s)
  })
})

describe("control", () => {
  it("maps each verb onto the manager", async () => {
    await dispatchSquadSubcommand(ctx("pause"))
    await dispatchSquadSubcommand(ctx("resume"))
    await dispatchSquadSubcommand(ctx("stop"))
    expect(managerPause).toHaveBeenCalledWith("team_1")
    expect(managerResume).toHaveBeenCalledWith("team_1")
    expect(managerShutdown).toHaveBeenCalledWith("team_1")
  })

  it("reports a runtime rejection rather than throwing at the composer", async () => {
    managerPause.mockRejectedValue(new Error("no live run"))
    const result = await dispatchSquadSubcommand(ctx("pause"))
    expect(result.system).toMatch(/Could not pause.*no live run/s)
  })
})

describe("tasks", () => {
  it("lists the board in board order", async () => {
    seed([squad()], {
      tasks: [
        { id: "t2", teamId: "team_1", title: "Second", status: "pending", order: 2 },
        { id: "t1", teamId: "team_1", title: "First", status: "completed", order: 1 },
        { id: "tx", teamId: "other", title: "Foreign", status: "pending", order: 0 },
      ],
    })
    const result = await dispatchSquadSubcommand(ctx("tasks"))
    expect(result.system.indexOf("First")).toBeLessThan(result.system.indexOf("Second"))
    expect(result.system).not.toContain("Foreign")
  })

  it("says the board is empty", async () => {
    const result = await dispatchSquadSubcommand(ctx("board"))
    expect(result.system).toMatch(/no tasks on its board/)
  })
})

describe("unknown subcommand", () => {
  /**
   * `/plan` treats an unknown head as an objective. `/squad` must not: a bare
   * word is far more likely a Squad name, and guessing would spend tokens.
   */
  it("returns usage instead of starting anything", async () => {
    const result = await dispatchSquadSubcommand(ctx("frobnicate"))
    expect(result.system).toContain("`/squad list`")
    expect(startSquadRun).not.toHaveBeenCalled()
  })
})
