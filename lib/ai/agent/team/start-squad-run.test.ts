/**
 * Tests for the one launch seam. Every collaborator is injected so the test
 * never imports the heavy Agent-Team graph. What is pinned here is the ORDER
 * and the fail-closed posture: readiness, the one-live-run rule, transactional
 * record creation, then (and only then) the lifecycle.
 */

import {
  mintSquadRunId,
  startSquadRun,
  type SquadRunRecordsSeed,
  type StartSquadRunDeps,
} from "./start-squad-run"
import type { ChatSession } from "@cognia/agent-config-types"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import type { SquadReadiness } from "@/lib/agent-team/squad-readiness"

interface Harness {
  runCalls: Array<Parameters<NonNullable<StartSquadRunDeps["runLifecycle"]>>[0]>
  updates: Array<{ squadId: string; updates: { task?: string } }>
  seeds: SquadRunRecordsSeed[]
  bindings: Array<{ executionRunId: string; projectId?: string; session: ChatSession }>
  deps: StartSquadRunDeps
}

const READY: SquadReadiness = { ready: true, blockers: [], evaluatedAt: 1 }

function harness(
  opts: {
    squadExists?: boolean
    readiness?: SquadReadiness
    liveRunId?: string
    recordsCreated?: boolean
    projectId?: string
  } = {}
): Harness {
  const runCalls: Harness["runCalls"] = []
  const updates: Harness["updates"] = []
  const seeds: SquadRunRecordsSeed[] = []
  const bindings: Harness["bindings"] = []
  const squadExists = opts.squadExists ?? true
  const store = {
    getTeam: (id: string) =>
      squadExists
        ? {
            id,
            name: "S",
            task: "stored objective",
            ...(opts.projectId ? { projectId: opts.projectId } : {}),
            config: {
              resourcePolicy: { priority: 3, maxConcurrentChildren: 1 },
              environmentRef: { environmentId: "env-1", versionId: "env-1:v2" },
            },
          }
        : undefined,
    getTeammates: () => [{ role: "teammate" }],
    getTeamTasks: () => [],
    updateTeam: (squadId: string, u: { task?: string }) => updates.push({ squadId, updates: u }),
  }
  const deps: StartSquadRunDeps = {
    loadStore: async () => store,
    evaluateReadiness: async () => opts.readiness ?? READY,
    findLiveRun: async () => (opts.liveRunId ? { id: opts.liveRunId } : undefined),
    createRunRecords: async (seed) => {
      seeds.push(seed)
      return {
        executionRunId: `execution:team:${seed.runId}`,
        created: opts.recordsCreated ?? true,
      }
    },
    bindConnectorRun: async (input) => {
      bindings.push(input)
    },
    runLifecycle: async (input) => {
      runCalls.push(input)
      return { runId: input.runId, status: "completed" }
    },
    resolveSessionCwd: async () => "/work",
    now: () => 1_000,
  }
  return { runCalls, updates, seeds, bindings, deps }
}

const chatTrigger: WorkflowTriggeredFrom = { source: "chat", sessionId: "s1" }

function session(): ChatSession {
  return { id: "s1", title: "T", createdAt: 1, updatedAt: 1 } as ChatSession
}

const start = (h: Harness, extra: Record<string, unknown> = {}) =>
  startSquadRun(
    { squadId: "squad-1", goal: "g", origin: "chat", triggeredFrom: chatTrigger, ...extra },
    h.deps
  )

describe("startSquadRun: fast failures", () => {
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
    expect(await start(h)).toEqual({ started: false, reason: "squad_not_found" })
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
    const h = harness()
    const res = await startSquadRun(
      {
        squadId: "squad-1",
        goal: "g",
        origin: "chat",
        triggeredFrom: chatTrigger,
        characterId: "x",
      },
      { ...h.deps, loadCharacter: async () => undefined }
    )
    expect(res).toMatchObject({ started: false, reason: "dispatch_error" })
    expect(h.runCalls).toHaveLength(0)
    expect(h.seeds).toHaveLength(0)
  })
})

describe("startSquadRun: readiness gate", () => {
  /** A blocked Squad stays visible and editable. It does not run. */
  it("refuses a Squad that is not ready, naming the blockers", async () => {
    const h = harness({
      readiness: {
        ready: false,
        blockers: [
          { code: "missing_environment_ref", action: "configure_environment" },
          { code: "no_teammates", action: "add_teammate" },
        ],
        evaluatedAt: 1,
      },
    })
    const res = await start(h)
    expect(res).toEqual({
      started: false,
      reason: "not_ready",
      blockers: [
        { code: "missing_environment_ref", action: "configure_environment" },
        { code: "no_teammates", action: "add_teammate" },
      ],
      squadName: "S",
    })
    expect(h.seeds).toHaveLength(0)
    expect(h.runCalls).toHaveLength(0)
    expect(h.updates).toHaveLength(0)
  })

  it("treats a readiness evaluator that throws as a dispatch error", async () => {
    const h = harness()
    h.deps.evaluateReadiness = async () => {
      throw new Error("db locked")
    }
    expect(await start(h)).toMatchObject({ started: false, reason: "dispatch_error" })
  })

  it("hands the roster to the evaluator, so an empty Squad is caught here", async () => {
    const h = harness()
    const evaluate = jest.fn(async () => READY)
    h.deps.evaluateReadiness = evaluate
    await start(h)
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ id: "squad-1" }), [
      { role: "teammate" },
    ])
  })
})

describe("startSquadRun: one live run per Squad", () => {
  it("returns the open run instead of forking a second one", async () => {
    const h = harness({ liveRunId: "run_team_open" })
    const res = await start(h)
    expect(res).toEqual({
      started: false,
      reason: "already_running",
      runId: "run_team_open",
      executionRunId: "execution:team:run_team_open",
      squadName: "S",
    })
    expect(h.seeds).toHaveLength(0)
    expect(h.runCalls).toHaveLength(0)
  })

  /** The same run id replayed is the same run, never a duplicate. */
  it("answers a replayed run id as a duplicate without dispatching again", async () => {
    const h = harness({ liveRunId: "run_team_same", recordsCreated: false })
    const res = await start(h, { runId: "run_team_same" })
    expect(res).toEqual({
      started: true,
      runId: "run_team_same",
      executionRunId: "execution:team:run_team_same",
      duplicate: true,
      squadName: "S",
    })
    expect(h.runCalls).toHaveLength(0)
  })
})

describe("startSquadRun: fail-closed record creation", () => {
  it("writes the records before firing the lifecycle, never after", async () => {
    const order: string[] = []
    const h = harness()
    const createRunRecords = h.deps.createRunRecords!
    h.deps.createRunRecords = async (seed) => {
      order.push("records")
      return createRunRecords(seed)
    }
    h.deps.runLifecycle = async (input) => {
      order.push("run")
      return { runId: input.runId, status: "completed" }
    }
    await start(h)
    expect(order).toEqual(["records", "run"])
  })

  it("starts nothing when the records cannot be written", async () => {
    const h = harness()
    h.deps.createRunRecords = async () => {
      throw new Error("quota")
    }
    const res = await start(h)
    expect(res).toEqual({ started: false, reason: "journal_failed", squadName: "S" })
    expect(h.runCalls).toHaveLength(0)
  })

  it("seeds the records with the Squad's workspace, priority, environment and conversation", async () => {
    const h = harness({ projectId: "ws-9" })
    await start(h, { session: session(), goal: "  ship the thing  " })
    expect(h.seeds).toEqual([
      expect.objectContaining({
        teamId: "squad-1",
        objective: "ship the thing",
        projectId: "ws-9",
        sessionId: "s1",
        origin: "chat",
        priority: 3,
        environmentVersionId: "env-1:v2",
        startedAt: 1_000,
      }),
    ])
  })

  it("falls back to the stored objective, then the name, for a blank goal", async () => {
    const h = harness()
    await start(h, { goal: "   " })
    expect(h.seeds[0]?.objective).toBe("stored objective")
    expect(h.updates).toHaveLength(0)
  })

  it("links a replacement to the run it replaces", async () => {
    const h = harness()
    await start(h, { parentRunId: "execution:team:old" })
    expect(h.seeds[0]?.parentRunId).toBe("execution:team:old")
  })

  it("records the run without a session, so an uncarded run is still listable", async () => {
    const h = harness()
    const res = await start(h)
    expect(res.started).toBe(true)
    expect(h.seeds[0]).not.toHaveProperty("sessionId")
    expect(h.bindings).toHaveLength(0)
  })
})

describe("startSquadRun: connector binding", () => {
  it("binds the run to the conversation only when asked, after the records", async () => {
    const h = harness({ projectId: "ws-1" })
    await start(h, { session: session(), bindConnectorRun: true })
    expect(h.bindings).toEqual([
      {
        executionRunId: h.seeds[0] && `execution:team:${h.seeds[0].runId}`,
        projectId: "ws-1",
        session: session(),
      },
    ])
  })

  it("does not bind a chat turn, which renders the run inline", async () => {
    const h = harness()
    await start(h, { session: session() })
    expect(h.bindings).toHaveLength(0)
  })

  it("never lets a binding failure reject the dispatch", async () => {
    const h = harness()
    h.deps.bindConnectorRun = async () => {
      throw new Error("no adapter")
    }
    const res = await start(h, { session: session(), bindConnectorRun: true })
    expect(res.started).toBe(true)
    expect(h.runCalls).toHaveLength(1)
  })
})

describe("startSquadRun: launching", () => {
  it("seeds the objective and hands the lifecycle its origin, trigger and run id", async () => {
    const h = harness()
    const res = await start(h, { goal: "  ship the thing  " })
    expect(res.started).toBe(true)
    expect(res.runId).toMatch(/^run_team_[0-9a-f]{12}$/)
    expect(res.executionRunId).toBe(`execution:team:${res.runId}`)
    expect(h.updates).toEqual([{ squadId: "squad-1", updates: { task: "ship the thing" } }])
    expect(h.runCalls).toEqual([
      expect.objectContaining({
        teamId: "squad-1",
        runId: res.runId,
        origin: "chat",
        triggeredFrom: chatTrigger,
      }),
    ])
  })

  it("reports the Squad's name so a caller need not import the store", async () => {
    const h = harness()
    expect((await start(h)).squadName).toBe("S")
  })

  it("honours a pre-minted run id so a caller can close over it", async () => {
    const h = harness()
    const res = await start(h, { runId: "run_team_preminted" })
    expect(res.runId).toBe("run_team_preminted")
    expect(h.runCalls[0]!.runId).toBe("run_team_preminted")
    expect(h.seeds[0]!.runId).toBe("run_team_preminted")
  })

  it("passes the approval channel, floor, ceiling and ultracode through only when supplied", async () => {
    const h = harness()
    const delegate = jest.fn()
    await start(h, {
      planApprovalDelegate: delegate,
      requirePlanApprovalFloor: true,
      ultracode: true,
      permissionCeiling: { maxMode: "default" },
    })
    expect(h.runCalls[0]).toMatchObject({
      planApprovalDelegate: delegate,
      requirePlanApprovalFloor: true,
      ultracode: true,
      permissionCeiling: { maxMode: "default" },
    })
    const h2 = harness()
    await start(h2)
    expect(h2.runCalls[0]).not.toHaveProperty("planApprovalDelegate")
    expect(h2.runCalls[0]).not.toHaveProperty("requirePlanApprovalFloor")
    expect(h2.runCalls[0]).not.toHaveProperty("ultracode")
  })

  it("hands the conversation's working directory to the lifecycle", async () => {
    const h = harness()
    await start(h, { session: session() })
    expect(h.runCalls[0]!.sessionWorkingDir).toBe("/work")
  })

  it("omits the working directory when the resolver fails", async () => {
    const h = harness()
    h.deps.resolveSessionCwd = async () => {
      throw new Error("no cwd")
    }
    await start(h, { session: session() })
    expect(h.runCalls[0]).not.toHaveProperty("sessionWorkingDir")
  })

  it("resolves the bound Character into an entry persona", async () => {
    const h = harness()
    h.deps.loadCharacter = async (id) => ({ id, name: "Ada", systemPrompt: "be Ada" })
    await start(h, { characterId: "char-1" })
    expect(h.runCalls[0]!.entryPersona).toEqual({
      id: "char-1",
      name: "Ada",
      systemPrompt: "be Ada",
    })
  })

  it("does not reject when the lifecycle itself throws", async () => {
    const h = harness()
    h.deps.runLifecycle = async () => {
      throw new Error("engine down")
    }
    const res = await start(h)
    expect(res.started).toBe(true)
  })
})

describe("mintSquadRunId", () => {
  it("produces the id shape the execution bridge and run list expect", () => {
    expect(mintSquadRunId()).toMatch(/^run_team_[0-9a-f]{12}$/)
  })
})
