/**
 * Tests for the host-neutral Squad run primitive. The team runtime / store /
 * deps loaders are injected so the test never imports the heavy Agent-Team
 * graph; the bridge is mocked because the two binding shapes (chat vs IM) are
 * the thing most worth pinning here.
 */

import { mintSquadRunId, startSquadRun, type StartSquadRunDeps } from "./start-squad-run"
import type { ChatSession } from "@cognia/agent-config-types"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"

const ensureTeamExecutionRunMock = jest.fn(async () => "execution:team:stub")
const ensureImTeamExecutionRunMock = jest.fn(async () => "execution:team:stub")
jest.mock("@/lib/execution/agent-team-bridge", () => ({
  ensureTeamExecutionRun: (...args: unknown[]) => ensureTeamExecutionRunMock(...(args as [never])),
  ensureImTeamExecutionRun: (...args: unknown[]) =>
    ensureImTeamExecutionRunMock(...(args as [never])),
  agentTeamExecutionRunId: (id: string) => `execution:team:${id}`,
}))

interface Harness {
  runCalls: Array<{ squadId: string; deps: Record<string, unknown> }>
  updates: Array<{ squadId: string; updates: { task?: string } }>
  deps: StartSquadRunDeps
}

function harness(opts: { squadExists?: boolean } = {}): Harness {
  const runCalls: Harness["runCalls"] = []
  const updates: Harness["updates"] = []
  const squadExists = opts.squadExists ?? true
  const store = {
    getTeam: (id: string) => (squadExists ? { id, name: "S" } : undefined),
    getTeammates: () => [],
    getTeamTasks: () => [],
    updateTeam: (squadId: string, u: { task?: string }) => updates.push({ squadId, updates: u }),
    addMessage: () => undefined,
    setTaskStatus: () => undefined,
    updateTeammate: () => undefined,
  }
  const deps: StartSquadRunDeps = {
    loadStore: async () => store,
    loadRunTeamLifecycle: async () => async (squadId: string, d: Record<string, unknown>) => {
      runCalls.push({ squadId, deps: d })
      return { runId: "run_1", status: "completed" }
    },
    loadBuildDeps: async () => () => ({ notifierDeps: { marker: true } }),
  }
  return { runCalls, updates, deps }
}

const chatTrigger: WorkflowTriggeredFrom = { source: "chat", sessionId: "s1" }

function session(): ChatSession {
  return { id: "s1", title: "T", createdAt: 1, updatedAt: 1 } as ChatSession
}

beforeEach(() => {
  ensureTeamExecutionRunMock.mockClear()
  ensureImTeamExecutionRunMock.mockClear()
})

describe("startSquadRun — fast failures", () => {
  it("refuses a blank Squad id before touching a loader", async () => {
    const h = harness()
    const loadStore = jest.fn(h.deps.loadStore!)
    const res = await startSquadRun(
      { squadId: "   ", goal: "g", origin: "chat", triggeredFrom: chatTrigger },
      { ...h.deps, loadStore }
    )
    expect(res).toEqual({ started: false, reason: "no_squad_id" })
    expect(loadStore).not.toHaveBeenCalled()
  })

  it("reports a Squad the store does not have", async () => {
    const h = harness({ squadExists: false })
    const res = await startSquadRun(
      { squadId: "squad-1", goal: "g", origin: "chat", triggeredFrom: chatTrigger },
      h.deps
    )
    expect(res).toEqual({ started: false, reason: "squad_not_found" })
    expect(h.runCalls).toHaveLength(0)
  })

  it("reports a loader failure instead of throwing at the caller", async () => {
    const res = await startSquadRun(
      { squadId: "squad-1", goal: "g", origin: "chat", triggeredFrom: chatTrigger },
      {
        loadStore: async () => {
          throw new Error("boom")
        },
      }
    )
    expect(res).toEqual({ started: false, reason: "dispatch_error" })
  })

  it("fails closed when the bound Character is gone", async () => {
    // Running the Squad as nobody would silently drop the persona the
    // conversation was configured with.
    const h = harness()
    const res = await startSquadRun(
      {
        squadId: "squad-1",
        goal: "g",
        origin: "chat",
        triggeredFrom: chatTrigger,
        characterId: "deleted",
      },
      { ...h.deps, loadCharacter: async () => undefined }
    )
    expect(res).toEqual({ started: false, reason: "dispatch_error" })
    expect(h.runCalls).toHaveLength(0)
  })
})

describe("startSquadRun — launching", () => {
  it("seeds the objective and hands the lifecycle its origin and trigger", async () => {
    const h = harness()
    const res = await startSquadRun(
      {
        squadId: "squad-1",
        goal: "  ship the thing  ",
        origin: "chat",
        triggeredFrom: chatTrigger,
      },
      h.deps
    )
    expect(res.started).toBe(true)
    expect(res.runId).toMatch(/^run_team_[0-9a-f]{12}$/)
    expect(h.updates).toEqual([{ squadId: "squad-1", updates: { task: "ship the thing" } }])
    expect(h.runCalls).toHaveLength(1)
    expect(h.runCalls[0]!.squadId).toBe("squad-1")
    expect(h.runCalls[0]!.deps.origin).toBe("chat")
    expect(h.runCalls[0]!.deps.triggeredFrom).toEqual(chatTrigger)
    // The caller's build-deps output is merged in, not replaced.
    expect(h.runCalls[0]!.deps.notifierDeps).toEqual({ marker: true })
  })

  it("reports the Squad's name so a caller need not import the store", async () => {
    // Importing the agent-team store into a chat surface would drag the whole
    // orchestration graph into its bundle.
    const h = harness()
    const res = await startSquadRun(
      { squadId: "squad-1", goal: "g", origin: "chat", triggeredFrom: chatTrigger },
      h.deps
    )
    expect(res.squadName).toBe("S")
  })

  it("omits the name when the Squad row carries none", async () => {
    const h = harness()
    h.deps.loadStore = async () => ({
      getTeam: (id: string) => ({ id }),
      getTeammates: () => [],
      getTeamTasks: () => [],
      updateTeam: () => undefined,
      addMessage: () => undefined,
      setTaskStatus: () => undefined,
      updateTeammate: () => undefined,
    })
    const res = await startSquadRun(
      { squadId: "squad-1", goal: "g", origin: "chat", triggeredFrom: chatTrigger },
      h.deps
    )
    expect(res.started).toBe(true)
    expect(res).not.toHaveProperty("squadName")
  })

  it("leaves the stored objective alone for a blank goal", async () => {
    const h = harness()
    await startSquadRun(
      { squadId: "squad-1", goal: "   ", origin: "chat", triggeredFrom: chatTrigger },
      h.deps
    )
    expect(h.updates).toHaveLength(0)
    expect(h.runCalls).toHaveLength(1)
  })

  it("honours a pre-minted run id so a caller can close over it", async () => {
    const h = harness()
    const res = await startSquadRun(
      {
        squadId: "squad-1",
        goal: "g",
        origin: "im",
        triggeredFrom: { source: "im", adapterId: "a", conversationKey: "c" },
        runId: "run_team_preminted",
      },
      h.deps
    )
    expect(res.runId).toBe("run_team_preminted")
    expect(h.runCalls[0]!.deps.runId).toBe("run_team_preminted")
  })

  it("passes the approval channel and floor through only when supplied", async () => {
    const h = harness()
    const delegate = jest.fn()
    await startSquadRun(
      {
        squadId: "squad-1",
        goal: "g",
        origin: "chat",
        triggeredFrom: chatTrigger,
        planApprovalDelegate: delegate,
        requirePlanApprovalFloor: true,
      },
      h.deps
    )
    expect(h.runCalls[0]!.deps.planApprovalDelegate).toBe(delegate)
    expect(h.runCalls[0]!.deps.requirePlanApprovalFloor).toBe(true)

    const h2 = harness()
    await startSquadRun(
      { squadId: "squad-1", goal: "g", origin: "chat", triggeredFrom: chatTrigger },
      h2.deps
    )
    expect(h2.runCalls[0]!.deps).not.toHaveProperty("planApprovalDelegate")
    expect(h2.runCalls[0]!.deps).not.toHaveProperty("requirePlanApprovalFloor")
  })
})

describe("startSquadRun — run binding", () => {
  it("creates a plain execution run for a chat turn", async () => {
    // Chat renders the run inline. Asking for a connector binding as well
    // would have the presentation runner project onto a thread that is
    // already showing it.
    const h = harness()
    await startSquadRun(
      {
        squadId: "squad-1",
        goal: "g",
        origin: "chat",
        triggeredFrom: chatTrigger,
        session: session(),
      },
      h.deps
    )
    expect(ensureTeamExecutionRunMock).toHaveBeenCalledTimes(1)
    expect(ensureImTeamExecutionRunMock).not.toHaveBeenCalled()
  })

  it("names the conversation on the run so a gate can find its way back", async () => {
    // `ExecutionRun.sessionId` was an indexed column team runs never filled,
    // so nothing could answer "which conversation started this?".
    const h = harness()
    await startSquadRun(
      {
        squadId: "squad-1",
        goal: "g",
        origin: "chat",
        triggeredFrom: chatTrigger,
        session: session(),
      },
      h.deps
    )
    expect(ensureTeamExecutionRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1" })
    )
  })

  it("creates the connector binding when the caller asks for one", async () => {
    const h = harness()
    await startSquadRun(
      {
        squadId: "squad-1",
        goal: "g",
        origin: "im",
        triggeredFrom: { source: "im", adapterId: "a", conversationKey: "c" },
        session: session(),
        bindConnectorRun: true,
      },
      h.deps
    )
    expect(ensureImTeamExecutionRunMock).toHaveBeenCalledTimes(1)
    expect(ensureTeamExecutionRunMock).not.toHaveBeenCalled()
  })

  it("binds before firing the lifecycle, never after", async () => {
    // Afterwards would race: the lifecycle can emit its first events before
    // the binding exists, and a runner only projects onto what it can see.
    const order: string[] = []
    ensureTeamExecutionRunMock.mockImplementationOnce(async () => {
      order.push("bind")
      return "execution:team:stub"
    })
    const h = harness()
    h.deps.loadRunTeamLifecycle = async () => async () => {
      order.push("run")
      return { runId: "run_1", status: "completed" }
    }
    await startSquadRun(
      {
        squadId: "squad-1",
        goal: "g",
        origin: "chat",
        triggeredFrom: chatTrigger,
        session: session(),
      },
      h.deps
    )
    expect(order).toEqual(["bind", "run"])
  })

  it("still dispatches when there is no session — just uncarded", async () => {
    const h = harness()
    const res = await startSquadRun(
      { squadId: "squad-1", goal: "g", origin: "chat", triggeredFrom: chatTrigger },
      h.deps
    )
    expect(res.started).toBe(true)
    expect(ensureTeamExecutionRunMock).not.toHaveBeenCalled()
    expect(h.runCalls).toHaveLength(1)
  })

  it("never lets a binding failure reject the dispatch", async () => {
    ensureTeamExecutionRunMock.mockRejectedValueOnce(new Error("dexie down"))
    const h = harness()
    const res = await startSquadRun(
      {
        squadId: "squad-1",
        goal: "g",
        origin: "chat",
        triggeredFrom: chatTrigger,
        session: session(),
      },
      h.deps
    )
    expect(res.started).toBe(true)
    expect(h.runCalls).toHaveLength(1)
  })

  it("does not reject when the lifecycle itself throws", async () => {
    // Fire-and-forget: failures surface through the run row and the
    // notification path, never as a rejected send.
    const h = harness()
    h.deps.loadRunTeamLifecycle = async () => async () => {
      throw new Error("lifecycle exploded")
    }
    await expect(
      startSquadRun(
        { squadId: "squad-1", goal: "g", origin: "chat", triggeredFrom: chatTrigger },
        h.deps
      )
    ).resolves.toEqual(expect.objectContaining({ started: true }))
  })
})

describe("mintSquadRunId", () => {
  it("produces the id shape the execution bridge and run list expect", () => {
    expect(mintSquadRunId()).toMatch(/^run_team_[0-9a-f]{12}$/)
    expect(mintSquadRunId()).not.toBe(mintSquadRunId())
  })
})
